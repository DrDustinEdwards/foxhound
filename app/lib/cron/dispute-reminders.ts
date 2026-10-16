import { and, eq, gte, isNotNull, isNull, lt, notInArray } from "drizzle-orm";

import { accounts, disputes, getDb } from "~/db";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import { REMINDER_BANDS, resolveReminderBucket } from "~/lib/disputes/notices";
import { sendDisputeReminderNotice } from "~/lib/disputes/notices.server";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";

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
// ONCE PER BAND, at the send layer: the reminder's idempotency key is the band
// and the dispute, so a second tick finds the email_sends claim and sends
// nothing. Recova's once-only marks were its dispute_reminder_3d and
// dispute_reminder_1d outcome rows, and those are recorded here too, after a
// real send, through recordOutcome (the money-write Durable Object).

export const DISPUTE_REMINDERS_CRON_NAME = "dispute-reminders";

/** Recova's CRON_BATCH_LIMIT for this query. */
export const DISPUTE_REMINDER_BATCH_LIMIT = 100;

const HOUR_MS = 60 * 60 * 1000;

export interface DisputeReminderRun {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** The open disputes whose deadline falls inside either band at `now`. */
async function dueDisputes(env: Env, now: Date) {
  const earliest = Math.min(...REMINDER_BANDS.map((b) => b.fromHours));
  const latest = Math.max(...REMINDER_BANDS.map((b) => b.toHours));
  return getDb(env)
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
        gte(disputes.evidenceDeadline, new Date(now.getTime() + earliest * HOUR_MS)),
        lt(disputes.evidenceDeadline, new Date(now.getTime() + latest * HOUR_MS)),
        accountProcessingEligibleCondition(),
        isNotNull(accounts.notificationEmail),
        eq(accounts.liveSendsEnabled, true),
      ),
    )
    .limit(DISPUTE_REMINDER_BATCH_LIMIT);
}

export async function runDisputeReminders(
  env: Env,
  now: Date,
  cronRunId: string | null = null,
): Promise<DisputeReminderRun> {
  const result: DisputeReminderRun = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  for (const dispute of await dueDisputes(env, now)) {
    if (!dispute.evidenceDeadline) continue;
    const hoursLeft = (dispute.evidenceDeadline.getTime() - now.getTime()) / HOUR_MS;
    const bucket = resolveReminderBucket(hoursLeft);
    if (!bucket) continue;
    result.considered++;

    const outcome = await sendDisputeReminderNotice(env, {
      accountId: dispute.accountId,
      disputeId: dispute.id,
      bucket,
      cronRunId,
    });
    if (outcome.kind === "error" || (outcome.kind === "sent" && outcome.result.status === "failed")) {
      result.failed++;
      continue;
    }
    if (outcome.kind !== "sent" || outcome.result.status !== "sent") {
      result.skipped++;
      continue;
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
      idempotencyKey: `${bucket.eventType}:${dispute.id}`,
    });
  }
  return result;
}

export function describeDisputeReminderRun(r: DisputeReminderRun): string {
  return `${r.considered} due, ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`;
}
