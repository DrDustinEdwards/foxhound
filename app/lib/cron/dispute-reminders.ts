import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { accounts, disputes, emailSends, emailSuppressions, getDb } from "~/db";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import { REMINDER_BANDS, reminderKey, type ReminderBucket } from "~/lib/disputes/notices";
import { sendDisputeReminderNotice } from "~/lib/disputes/notices.server";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { HOUR_MS } from "~/lib/constants";

// THE DISPUTE DEADLINE REMINDER.
//
// The query excludes a dispute whose claim for this band already stands with no
// error (sent, or in flight), so a reminded dispute is never selected again: no
// notice load, no suppression check, no claim attempt and no log row on the
// ticks after.

export const DISPUTE_REMINDERS_CRON_NAME = "dispute-reminders";

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
      autoSubmit: accounts.disputeAutoSubmit,
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
                eq(
                  emailSends.idempotencyKey,
                  sql`${reminderKey(band.eventType, "")} || ${disputes.id}`,
                ),
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
            .where(
              and(
                eq(emailSuppressions.email, accounts.notificationEmail),
                isNotNull(emailSuppressions.suppressedAt),
              ),
            ),
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
  dispute: {
    id: string;
    accountId: string;
    stripeDisputeId: string;
    evidenceDeadline: Date | null;
    autoSubmit: boolean | null;
  },
  result: DisputeReminderRun,
): Promise<void> {
  const hoursLeft =
    ((dispute.evidenceDeadline?.getTime() ?? now.getTime()) - now.getTime()) / HOUR_MS;
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
  await recordOutcome(env, {
    accountId: dispute.accountId,
    product: "disputes",
    eventType: bucket.eventType,
    eventData: {
      dispute_id: dispute.stripeDisputeId,
      hours_left: Math.round(hoursLeft),
      auto_submit: dispute.autoSubmit ?? false,
    },
    outcome: "sent",
    outcomeAt: now,
    idempotencyKey: reminderKey(bucket.eventType, dispute.id),
  });
}

export function describeDisputeReminderRun(r: DisputeReminderRun): string {
  return `${r.considered} due, ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed`;
}
