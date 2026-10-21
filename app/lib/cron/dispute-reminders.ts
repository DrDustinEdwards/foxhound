import { and, asc, eq, gt, gte, isNotNull, isNull, lt, notExists, notInArray, or, sql } from "drizzle-orm";

import { accounts, disputes, emailSends, emailSuppressions, getDb } from "~/db";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import { REMINDER_BANDS, reminderKey, type ReminderBucket } from "~/lib/disputes/notices";
import { sendDisputeReminderNotice } from "~/lib/disputes/notices.server";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { HOUR_MS } from "~/lib/constants";

// THE DISPUTE DEADLINE REMINDER (J06, job_4f4c9c2f5383). Recova's spec is
// app/api/cron/process-disputes/route.ts (blob 1cbd5bd0, 21,298 bytes), "Thing
// 1", read whole. Its "Thing 2" (auto-submit) is deliberately not built
// (RULES.md 5.6), and its "Thing 3" (a fee-row safety net) has no Foxhound
// counterpart to back up, because the resolution batch snapshots the fee in
// the same write that resolves the dispute.
//
// WHO IS REMINDED, Recova's selection in Foxhound's vocabulary:
// - an open dispute nobody has submitted: Recova's `submitted_by IS NULL` and
//   `status = 'needs_response'` are Foxhound's submitted_at null and a state
//   before submission;
// - with an evidence deadline inside one of the two bands (72 to 96 hours, the
//   "3 days" reminder; 24 to 48 hours, the "1 day" one);
// - on an account that is not paused, as Recova's `processing_paused` skip.
//   accountProcessingEligibleCondition also excludes cancelled and demo
//   accounts, which Recova reached through its active-product and non-demo
//   gates;
// - with a notification address, as Recova's `!account.notification_email`
//   skip.
//
// ONE MORE FILTER THAN RECOVA, and why: an account with live sends off is not
// selected. This job rides the five-minute tick (see the registry), so a
// switched-off account would log a `blocked` email_sends row for each dispute
// on every tick for a day. The account gets no mail either way; selecting it
// would only fill the log. When the merchant is switched on, a dispute still
// inside its band is reminded on the next tick.
//
// ONCE PER BAND, IN THE SELECTION (PR 149 review, MEDIUM). The reminder's
// idempotency key is `<band>:<dispute id>`, and the send claim stores it on
// its email_sends row before the provider is called. The query excludes a
// dispute whose claim for this band already stands with no error (sent, or in
// flight), so a reminded dispute is never selected again: no notice load, no
// suppression check, no claim attempt and no log row on the ticks after. A
// claim the provider refused carries its error and stays selectable, and the
// send layer retakes it, so a failed send is tried again once its back-off
// has passed (below).
// Recova kept the same exclusion in memory (its sentReminders set).
//
// NO DISPUTE STARVES. Each band is its own query, its window in SQL (so the
// 48 to 72 hour gap is never selected), ordered by deadline, soonest first,
// under the batch limit. With reminded disputes excluded, a band holding more
// than the limit drains over consecutive ticks instead of returning the same
// rows forever.
//
// A REFUSED SEND BACKS OFF (job_2663d92094ab). The send layer keeps a refused
// claim's row with its error, and its created_at is the time of the last
// attempt (the claim and every retake write it). The selection skips a dispute
// whose band claim was refused less than REFUSED_REMINDER_BACKOFF_MS ago, so a
// provider that keeps refusing is asked about once an hour, at most 24 times in
// a band, instead of on every five-minute tick (about 288).
//
// A SUPPRESSED ADDRESS IS NOT SELECTED. The send layer would log a
// `suppressed` row for it and keep no key, so the query reads the same
// suppression list isSuppressed reads (an exact match on the address) and
// skips it. Recova's outcome rows (dispute_reminder_3d and _1d) are still
// recorded after a real send, through recordOutcome (the money-write Durable
// Object).

export const DISPUTE_REMINDERS_CRON_NAME = "dispute-reminders";

/** Recova's CRON_BATCH_LIMIT for this query. */
const DISPUTE_REMINDER_BATCH_LIMIT = 100;

/** How long a refused reminder send waits before it is tried again. */
export const REFUSED_REMINDER_BACKOFF_MS = HOUR_MS;

export interface DisputeReminderRun {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** One band's open, unreminded disputes at `now`, soonest deadline first. */
async function dueInBand(env: Env, now: Date, band: (typeof REMINDER_BANDS)[number]) {
  const db = getDb(env);
  return db
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      stripeDisputeId: disputes.stripeDisputeId,
      evidenceDeadline: disputes.evidenceDeadline,
    })
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .where(
      and(
        notInArray(disputes.state, SUBMITTED_OR_RESOLVED as string[]),
        isNull(disputes.submittedAt),
        isNotNull(disputes.evidenceDeadline),
        gte(disputes.evidenceDeadline, new Date(now.getTime() + band.fromHours * HOUR_MS)),
        lt(disputes.evidenceDeadline, new Date(now.getTime() + band.toHours * HOUR_MS)),
        accountProcessingEligibleCondition(),
        isNotNull(accounts.notificationEmail),
        eq(accounts.liveSendsEnabled, true),
        notExists(
          db
            .select({ one: sql`1` })
            .from(emailSends)
            .where(
              and(
                // reminderKey(band.eventType, disputes.id), in SQL.
                eq(emailSends.idempotencyKey, sql`${reminderKey(band.eventType, "")} || ${disputes.id}`),
                // Sent or in flight, or refused inside the back-off.
                or(
                  isNull(emailSends.error),
                  gt(emailSends.createdAt, new Date(now.getTime() - REFUSED_REMINDER_BACKOFF_MS)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(emailSuppressions)
            .where(and(eq(emailSuppressions.email, accounts.notificationEmail), isNotNull(emailSuppressions.suppressedAt))),
        ),
      ),
    )
    .orderBy(asc(disputes.evidenceDeadline))
    .limit(DISPUTE_REMINDER_BATCH_LIMIT);
}

export async function runDisputeReminders(
  env: Env,
  now: Date,
  cronRunId: string | null = null,
): Promise<DisputeReminderRun> {
  const result: DisputeReminderRun = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  for (const band of REMINDER_BANDS) {
    const bucket: ReminderBucket = { eventType: band.eventType, daysLeft: band.daysLeft };
    for (const dispute of await dueInBand(env, now, band)) {
      await remindOne(env, now, cronRunId, bucket, dispute, result);
    }
  }
  return result;
}

async function remindOne(
  env: Env,
  now: Date,
  cronRunId: string | null,
  bucket: ReminderBucket,
  dispute: { id: string; accountId: string; stripeDisputeId: string; evidenceDeadline: Date | null },
  result: DisputeReminderRun,
): Promise<void> {
  const hoursLeft = ((dispute.evidenceDeadline?.getTime() ?? now.getTime()) - now.getTime()) / HOUR_MS;
  result.considered++;

  const outcome = await sendDisputeReminderNotice(env, {
    accountId: dispute.accountId,
    disputeId: dispute.id,
    bucket,
    cronRunId,
  });
  if (outcome.kind === "error" || (outcome.kind === "sent" && outcome.result.status === "failed")) {
    result.failed++;
    return;
  }
  if (outcome.kind !== "sent" || outcome.result.status !== "sent") {
    result.skipped++;
    return;
  }
  result.sent++;
  // Recova's outcome, after the send and keyed so it is written once.
  await recordOutcome(env, {
    accountId: dispute.accountId,
    product: "disputes",
    eventType: bucket.eventType,
    eventData: {
      dispute_id: dispute.stripeDisputeId,
      hours_left: Math.round(hoursLeft),
      auto_submit: false,
    },
    outcome: "sent",
    outcomeAt: now,
    idempotencyKey: reminderKey(bucket.eventType, dispute.id),
  });
}

export function describeDisputeReminderRun(r: DisputeReminderRun): string {
  return `${r.considered} due, ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`;
}
