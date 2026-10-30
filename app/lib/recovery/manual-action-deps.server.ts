// Injected IO for the manual Trigger and Resend actions
// (manual-actions.server.ts), with the real bindings wired by resendDepsFor and
// triggerDepsFor so tests can drive the dispatcher with fakes.

import { and, eq } from "drizzle-orm";
import { type Db, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import { queryStepForManualTrigger, type DueStepRow } from "~/lib/cron/due-steps";
import { executeEmailStep, type EmailStepContext, type EmailStepResult } from "~/lib/engine/execute-step";
import { executeRetryStep, type RetryStepContext, type RetryStepResult } from "~/lib/engine/retry-step";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { footerSenderName } from "~/lib/email/templates";
import type { EmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { TEMPLATE_LABEL_RESEND } from "./manual-action-batches.server";

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The IO the trigger intent needs, injected so the dispatcher never touches
 * `Env` directly and both executor branches are drivable in tests. The defaults
 * are the cron's own loader and executors; nothing here is a parallel engine.
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

/** The merchant's sender for a resend: `sender_name` for the From name (E9)
 *  and `reply_to_email` for the Reply-To, both raw and nullable, on the
 *  connection the step's payment came through, as the engine's send reads
 *  them. Scoped to the account, so a step id never reads another merchant's
 *  connection. */
async function resendSender(
  env: Env,
  accountId: string,
  stepId: string,
): Promise<{ senderName: string | null; replyTo: string | null }> {
  const rows = await getDb(env)
    .select({ senderName: stripeConnections.senderName, replyTo: stripeConnections.replyToEmail })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .innerJoin(stripeConnections, eq(stripeConnections.id, failedPayments.stripeConnectionId))
    .where(and(eq(recoverySteps.id, stepId), eq(recoverySteps.accountId, accountId)))
    .limit(1);
  return { senderName: rows[0]?.senderName ?? null, replyTo: rows[0]?.replyTo ?? null };
}

/**
 * Recova's resend footer line (app/api/payments/[id]/resend/route.ts, blob
 * 35132cb6, line 61): `&copy; ${year} ${senderName}`, with the sender name as
 * its From has it (`sender_name || 'Support'`). It is the resend's own line,
 * not the engine's "You're receiving this from" sentence, because Recova's
 * resend wraps the stored body in its route's own shell. Pure.
 */
export function resendFooterNote(senderName: string | null | undefined, year: number): string {
  return `\u00a9 ${year} ${footerSenderName(senderName)}`;
}

/**
 * Bind the real send path to `env`: processEmailJob, which is suppression gate,
 * live-send flag, send, and email_sends log, in that order. `queueMessageId` is
 * null because this is the synchronous path, exactly as the engine's defaultSend
 * passes null.
 *
 * THE CAN-SPAM FIELDS ARE ASSEMBLED HERE, and this is where legacy's resend
 * differs most. Legacy's route sends a raw provider call with NO unsubscribe
 * token and NO List-Unsubscribe header, two of the four defects its own sibling
 * trigger route documents as the degraded parallel it removed from itself (scope
 * 1.5). EmailJob makes them non-optional, and buildEmailMessage throws without a
 * physical address, so the pipeline refuses to send a non-compliant message at
 * all. 262 decision three ports the intent, not the defect.
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
        // E9: Recova's From name, `sender_name || 'Support'` (send.ts applies
        // the Support fallback to a null name).
        fromName: sender.senderName,
        replyTo: sender.replyTo,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        template: TEMPLATE_LABEL_RESEND,
        unsubscribeToken,
        physicalAddress: env.PHYSICAL_ADDRESS ?? "",
        // E9: Recova's resend footer line, first in the footer slot, before
        // the approved unsubscribe link and postal address.
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
