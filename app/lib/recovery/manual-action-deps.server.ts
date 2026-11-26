// Injected IO for the manual Trigger and Resend actions
// (manual-actions.server.ts), with the real bindings wired by resendDepsFor and
// triggerDepsFor so tests can drive the dispatcher with fakes.

import { and, eq } from "drizzle-orm";
import { accounts, type Db, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import { senderNameOrAccountName } from "~/lib/stripe/connections.server";
import { queryStepForManualTrigger, type DueStepRow } from "~/lib/cron/due-steps";
import {
  executeEmailStep,
  type EmailStepContext,
  type EmailStepResult,
} from "~/lib/engine/execute-step";
import {
  executeRetryStep,
  type RetryStepContext,
  type RetryStepResult,
} from "~/lib/engine/retry-step";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { footerSenderName } from "~/lib/email/templates";
import type { EmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { TEMPLATE_LABEL_RESEND } from "./manual-action-batches.server";

/**
 * The IO the trigger intent needs, injected so the dispatcher never touches `Env` directly and both
 * executor branches are drivable in tests.
 */
export interface TriggerDeps {
  loadStep: (accountId: string, stepId: string) => Promise<DueStepRow | null>;
  runRetry: (ctx: RetryStepContext) => Promise<RetryStepResult>;
  runEmail: (ctx: EmailStepContext) => Promise<EmailStepResult>;
}

/**
 * The IO the resend intent needs. One seam, so the send path is drivable in
 * tests without a Workers runtime and the dispatcher never touches `Env`.
 */
export interface ResendSendInput {
  accountId: string;
  recoveryStepId: string;
  to: string;
  subject: string;
  bodyHtml: string;
  now: Date;
}

export interface ResendDeps {
  send: (input: ResendSendInput) => Promise<EmailJobResult>;
}

/**
 * The merchant's sender for a resend: `sender_name` for the From name and `reply_to_email` for the
 * Reply-To, both raw and nullable, on the connection the step's payment came through, as the
 * engine's send reads them. Scoped to the account, so a step id never reads another merchant's
 * connection.
 */
async function resendSender(
  env: Env,
  accountId: string,
  stepId: string,
): Promise<{ senderName: string | null; replyTo: string | null }> {
  const rows = await getDb(env)
    .select({
      senderName: senderNameOrAccountName(stripeConnections.senderName, accounts.name),
      replyTo: stripeConnections.replyToEmail,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .innerJoin(accounts, eq(accounts.id, recoverySteps.accountId))
    .innerJoin(stripeConnections, eq(stripeConnections.id, failedPayments.stripeConnectionId))
    .where(and(eq(recoverySteps.id, stepId), eq(recoverySteps.accountId, accountId)))
    .limit(1);
  return { senderName: rows[0]?.senderName ?? null, replyTo: rows[0]?.replyTo ?? null };
}

/** Pure. */
export function resendFooterNote(senderName: string | null | undefined, year: number): string {
  return `\u00a9 ${year} ${footerSenderName(senderName)}`;
}

/**
 * Bind the real send path to `env`: processEmailJob, which is suppression gate, live-send flag,
 * send, and email_sends log, in that order.
 */
export function resendDepsFor(env: Env): ResendDeps {
  return {
    send: async (input) => {
      const unsubscribeToken = await signUnsubscribeToken(env, {
        email: input.to,
        accountId: input.accountId,
      });
      const sender = await resendSender(env, input.accountId, input.recoveryStepId);
      const job: EmailJob = {
        accountId: input.accountId,
        recoveryStepId: input.recoveryStepId,
        to: input.to,
        fromName: sender.senderName,
        replyTo: sender.replyTo,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        template: TEMPLATE_LABEL_RESEND,
        unsubscribeToken,
        physicalAddress: env.PHYSICAL_ADDRESS ?? "",
        footerNote: resendFooterNote(sender.senderName, input.now.getUTCFullYear()),
        idempotencyKey: `resend:${input.recoveryStepId}:${input.now.getTime()}`,
      };
      return processEmailJob(env, job, null);
    },
  };
}

/** Bind the real executors to `env`. The route's only job is to call this. */
export function triggerDepsFor(env: Env, db: Db): TriggerDeps {
  return {
    loadStep: (accountId, stepId) => queryStepForManualTrigger(db, accountId, stepId),
    runRetry: (ctx) => executeRetryStep(env, ctx),
    runEmail: (ctx) => executeEmailStep(env, ctx),
  };
}
