import { and, eq, isNull, lte, notLike, or, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, stripeConnections, winBackSequences, winBackSteps } from "~/db";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { processEmailJob } from "~/lib/email/dispatch";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";

import {
  buildWinbackEmail,
  winbackSubject,
  WINBACK_TEMPLATE,
} from "~/lib/recovery/winback-email";
import { isLastWinbackStep, WINBACK_STATUS } from "~/lib/recovery/winback";

// THE WIN-BACK SEND CRON. Ported from legacy's
// app/api/cron/process-winback/route.ts (blob `18f20de9`, 24,184 bytes).
//
// The TRIGGER half already shipped at 290 to 292: `customer.subscription.deleted`
// creates the sequence and its three steps at 1h, 96h and 336h. What was absent
// is this, the pass that actually sends them, plus the outcomes and the
// reactivation (343's reversal).
//
// EVERY STEP'S ONLY BUTTON IS `{{resubscribe_url}}`, which is why 343's ORDER
// clause put the /p/:token resubscribe mode in session 51 and this cron second:
// a sent email whose only button has no target is a false promise.
//
// NOT A RECOVERY STEP. A win-back step never enters `decideEmailStep`; it is its
// own table with its own claim, exactly as legacy has it.

/** One tick's cap, matching the recovery tick's shape. Legacy uses
 *  `CRON_BATCH_LIMIT` on the same query. */
export const WINBACK_SEND_LIMIT = 100;

export interface WinbackSendResult {
  sent: number;
  skipped: number;
}

export interface DueWinbackStep {
  stepId: string;
  sequenceId: string;
  accountId: string;
  stepNumber: number;
  customerEmail: string;
  customerName: string | null;
  planName: string | null;
  amountCents: number | null;
  notificationsEnabled: boolean | null;
  senderName: string | null;
}

/**
 * The due-step query, legacy's filters one for one.
 *
 * THE DEMO EXCLUSION IS HERE, at the query, which is legacy's own placement
 * (`.not('account_id','in', DEMO_ACCOUNT_IDS_FILTER)`) and the same
 * prefix firewall every other Foxhound cron applies. `processEmailJob`'s
 * `liveSendsEnabled` gate is the second, independent layer.
 */
export async function queryDueWinbackSteps(
  db: Db,
  now: Date,
  limit: number = WINBACK_SEND_LIMIT,
): Promise<DueWinbackStep[]> {
  const rows = await db
    .select({
      stepId: winBackSteps.id,
      sequenceId: winBackSequences.id,
      accountId: winBackSequences.accountId,
      stepNumber: winBackSteps.stepNumber,
      customerEmail: winBackSequences.customerEmail,
      customerName: winBackSequences.customerName,
      planName: winBackSequences.planName,
      amountCents: winBackSequences.amountCents,
      notificationsEnabled: accounts.winbackNotificationsEnabled,
      senderName: sql<string | null>`(
        select ${stripeConnections.senderName} from ${stripeConnections}
        where ${stripeConnections.accountId} = ${winBackSequences.accountId}
          and ${stripeConnections.isPrimary} = 1
          and ${stripeConnections.disconnectedAt} is null
        limit 1
      )`,
    })
    .from(winBackSteps)
    .innerJoin(winBackSequences, eq(winBackSequences.id, winBackSteps.winBackSequenceId))
    .innerJoin(accounts, eq(accounts.id, winBackSequences.accountId))
    .where(
      and(
        isNull(winBackSteps.executedAt),
        isNull(winBackSteps.result),
        isNull(winBackSteps.deletedAt),
        lte(winBackSteps.scheduledAt, now),
        // Legacy's backoff gate: a step whose last send failed transiently
        // waits out `next_retry_at`; a fresh step carries NULL.
        or(isNull(winBackSteps.nextRetryAt), lte(winBackSteps.nextRetryAt, now)),
        eq(winBackSequences.status, WINBACK_STATUS.ACTIVE),
        notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
        accountProcessingEligibleCondition(),
      ),
    )
    .limit(limit);
  return rows.filter((r): r is DueWinbackStep => r.accountId !== null);
}

/** Stamp a step terminal with legacy's result string, without claiming a send. */
export async function stampStep(
  db: Db,
  stepId: string,
  result: string,
  now: Date,
): Promise<void> {
  await db
    .update(winBackSteps)
    .set({ executedAt: now, result })
    .where(and(eq(winBackSteps.id, stepId), isNull(winBackSteps.executedAt)));
}

/**
 * THE SEND CLAIM. Conditional on `executed_at IS NULL`, so only the tick that
 * flips it records the outcome, which is legacy's rule verbatim: "only the tick
 * that flips executed_at records the outcome, so the moat never double-counts a
 * send". Returns whether this call took the claim.
 */
export async function claimStepSent(db: Db, stepId: string, now: Date): Promise<boolean> {
  await db
    .update(winBackSteps)
    .set({ executedAt: now, result: "email_sent_fallback" })
    .where(and(eq(winBackSteps.id, stepId), isNull(winBackSteps.executedAt)));
  const rows = await db
    .select({ executedAt: winBackSteps.executedAt })
    .from(winBackSteps)
    .where(eq(winBackSteps.id, stepId))
    .limit(1);
  return rows[0]?.executedAt?.getTime() === now.getTime();
}

/**
 * THE TERMINAL FLIP. Legacy runs `if (step.step_number === 3) update status
 * 'completed'` unconditionally after the claim; Foxhound's status vocabulary
 * calls that state `exhausted` (290 to 292) and the update is CONDITIONAL on
 * `status = 'active'`, which is 340 binding 1's stronger shape.
 *
 * 344 binding 4: an exhausted sequence stays RESUBSCRIBABLE, because step 3's
 * own button must outlive the flip its own send causes.
 */
export async function claimSequenceExhausted(
  db: Db,
  sequenceId: string,
  now: Date,
): Promise<void> {
  await db
    .update(winBackSequences)
    .set({ status: WINBACK_STATUS.EXHAUSTED, resolvedAt: now })
    .where(
      and(eq(winBackSequences.id, sequenceId), eq(winBackSequences.status, WINBACK_STATUS.ACTIVE)),
    );
}

async function signUnsubscribeFor(env: Env, email: string, accountId: string): Promise<string> {
  const { signUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
  return signUnsubscribeToken(env, { email, accountId });
}

/** One tick: send every due win-back step. */
export async function runWinbackSends(env: Env, now: Date): Promise<WinbackSendResult> {
  const db = getDb(env);
  const result: WinbackSendResult = { sent: 0, skipped: 0 };
  const due = await queryDueWinbackSteps(db, now);

  for (const step of due) {
    // NULL is ON (337 binding 3). A disabled account's step is stamped with
    // legacy's own result string so it is never reconsidered.
    if (step.notificationsEnabled === false) {
      await stampStep(db, step.stepId, "skipped_notifications_disabled", now);
      result.skipped += 1;
      continue;
    }

    try {
      const token = await signCardUpdateToken(env, {
        winBackSequenceId: step.sequenceId,
        winBackStepNumber: step.stepNumber,
        accountId: step.accountId,
      });
      const outcome = await processEmailJob(
        env,
        {
          accountId: step.accountId,
          to: step.customerEmail,
          fromName: step.senderName,
          subject: winbackSubject({ stepNumber: step.stepNumber, planName: step.planName }),
          bodyHtml: buildWinbackEmail({
            stepNumber: step.stepNumber,
            customerName: step.customerName,
            planName: step.planName,
            senderName: step.senderName,
            resubscribeUrl: `${env.BETTER_AUTH_URL ?? ""}/p/${token}`,
          }),
          template: WINBACK_TEMPLATE,
          // CUSTOMER audience: footer, unsubscribe headers and the suppression
          // gate all apply, because this is commercial mail sent on the
          // merchant's behalf.
          unsubscribeToken: await signUnsubscribeFor(env, step.customerEmail, step.accountId),
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          idempotencyKey: `winback-step:${step.stepId}`,
          cronRunId: null,
        },
        null,
      );

      if (outcome.status === "suppressed") {
        // Legacy's `skipped_unsubscribed`, terminal. An unsubscribed customer
        // is not asked again by a later tick.
        await stampStep(db, step.stepId, "skipped_unsubscribed", now);
        result.skipped += 1;
        continue;
      }
      if (outcome.status !== "sent") {
        // NOT STAMPED, and this is where the win-back deliberately differs from
        // the expiring-card alert. That alert stamps a blocked send because
        // leaving it unstamped burns a Stripe call every night forever; a
        // win-back step costs one query. A merchant who has not turned live
        // sends on yet, or a transient failure, must not permanently consume
        // the step, so it is left for the next tick. The `email_sends` row
        // already records what happened.
        result.skipped += 1;
        continue;
      }

      const claimed = await claimStepSent(db, step.stepId, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      // THE SEND OUTCOME, at legacy's fields, recorded only by the tick that
      // took the claim. A MOAT row, never a billing row: billable.ts keys on
      // recovered_payments and findAttributionSignals reads recovery_steps,
      // and a win-back touches neither (343 binding 1).
      await recordOutcome(env, {
        accountId: step.accountId,
        product: "recovery",
        eventType: "winback_email_sent",
        outcome: "sent",
        eventData: {
          stepNumber: step.stepNumber,
          amountCents: step.amountCents,
        },
        idempotencyKey: `winback-email:${step.stepId}`,
        outcomeAt: now,
      });

      if (isLastWinbackStep(step.stepNumber)) {
        await claimSequenceExhausted(db, step.sequenceId, now);
      }
      result.sent += 1;
    } catch (err) {
      console.error(
        `winback send failed for step ${step.stepId}:`,
        err instanceof Error ? err.message : err,
      );
      result.skipped += 1;
    }
  }
  return result;
}

export function describeWinbackRun(result: WinbackSendResult): string {
  return `${result.sent} sent, ${result.skipped} skipped`;
}
