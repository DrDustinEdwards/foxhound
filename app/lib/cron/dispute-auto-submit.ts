import { logEvent } from "@dustinedwards/site-runtime/log";
import { and, asc, eq, gt, isNotNull, isNull, lte, notExists, notInArray, sql } from "drizzle-orm";

import { accounts, disputeApprovals, disputes, getDb } from "~/db";
import { HOUR_MS } from "~/lib/constants";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { DISPUTE_AUTO_SUBMIT_HOURS, SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import { sendDisputeAutoSubmittedNotice } from "~/lib/disputes/notices.server";
import {
  approveAndSubmitDispute,
  getConnectionAccessToken,
  getDisputeDetail,
} from "~/lib/disputes/queries.server";
import { recordOutcome } from "~/lib/engine/outcomes";

// DISPUTE AUTO-SUBMIT, opt-in and off by default. One dispute's failure never
// stops the rest.
//
// This job submits through approveAndSubmitDispute, the same path the dispute
// page's Approve and submit uses: Phase A writes the dispute_approvals row,
// naming that person, with standing_opt_in_at set to when they opted in; Phase
// B submits to Stripe; Phase C marks the dispute submitted (submitted_by
// foxhound_auto) only after Stripe accepts.

const DISPUTE_AUTO_SUBMIT_BATCH_LIMIT = 100;

export interface DisputeAutoSubmitRun {
  considered: number;
  submitted: number;
  failed: number;
}

/** Disputes due an automatic submission at `now`, soonest deadline first. */
async function dueForAutoSubmit(env: Env, now: Date) {
  const db = getDb(env);
  return db
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      stripeDisputeId: disputes.stripeDisputeId,
      stripeConnectionId: disputes.stripeConnectionId,
      evidenceDeadline: disputes.evidenceDeadline,
      optInUserId: accounts.disputeAutoSubmitByUserId,
      optInEmail: accounts.disputeAutoSubmitByEmail,
      optInAt: accounts.disputeAutoSubmitAt,
    })
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .where(
      and(
        notInArray(disputes.state, SUBMITTED_OR_RESOLVED as string[]),
        isNull(disputes.submittedAt),
        eq(disputes.status, "needs_response"),
        gt(disputes.evidenceDeadline, now),
        lte(
          disputes.evidenceDeadline,
          new Date(now.getTime() + DISPUTE_AUTO_SUBMIT_HOURS * HOUR_MS),
        ),
        isNotNull(disputes.stripeConnectionId),
        eq(accounts.disputeAutoSubmit, true),
        isNotNull(accounts.disputeAutoSubmitAt),
        isNotNull(accounts.disputeAutoSubmitByEmail),
        eq(accounts.disputesEnabled, true),
        accountProcessingEligibleCondition(),
        notExists(
          db
            .select({ one: sql`1` })
            .from(disputeApprovals)
            .where(eq(disputeApprovals.disputeId, disputes.id)),
        ),
      ),
    )
    .orderBy(asc(disputes.evidenceDeadline))
    .limit(DISPUTE_AUTO_SUBMIT_BATCH_LIMIT);
}

type DueDispute = Awaited<ReturnType<typeof dueForAutoSubmit>>[number];

export async function runDisputeAutoSubmit(
  env: Env,
  now: Date,
  cronRunId: string | null = null,
): Promise<DisputeAutoSubmitRun> {
  const result: DisputeAutoSubmitRun = { considered: 0, submitted: 0, failed: 0 };
  for (const dispute of await dueForAutoSubmit(env, now)) {
    result.considered++;
    try {
      if (await autoSubmitOne(env, now, cronRunId, dispute)) result.submitted++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      logEvent(
        "dispute_auto_submit_failed",
        { dispute_id: dispute.id, error: err },
        { level: "error" },
      );
    }
  }
  return result;
}

/** One automatic submission. True when Stripe took it and it is recorded. */
async function autoSubmitOne(
  env: Env,
  now: Date,
  cronRunId: string | null,
  dispute: DueDispute,
): Promise<boolean> {
  const db = getDb(env);
  const token = dispute.stripeConnectionId
    ? await getConnectionAccessToken(db, dispute.stripeConnectionId)
    : null;
  const detail = await getDisputeDetail(db, dispute.accountId, dispute.id);
  if (!token || !detail || !dispute.optInEmail || !dispute.optInAt) {
    console.error(
      `dispute auto-submit skipped dispute ${dispute.id}: no Stripe connection or opt-in`,
    );
    return false;
  }

  const submission = await approveAndSubmitDispute(
    db,
    env,
    {
      disputeId: dispute.id,
      accountId: dispute.accountId,
      stripeDisputeId: dispute.stripeDisputeId,
      connectionAccessToken: token,
      approvedByUserId: dispute.optInUserId,
      approvedByEmail: dispute.optInEmail,
      approvedAt: now,
      standingOptInAt: dispute.optInAt,
    },
    detail.evidence,
  );
  if (submission.status === "error") {
    logEvent(
      "dispute_auto_submit_refused",
      { dispute_id: dispute.id, message: submission.message },
      { level: "error" },
    );
    return false;
  }

  const hoursLeft =
    ((dispute.evidenceDeadline?.getTime() ?? now.getTime()) - now.getTime()) / HOUR_MS;
  await recordOutcome(env, {
    accountId: dispute.accountId,
    product: "disputes",
    eventType: "dispute_auto_submitted",
    eventData: { dispute_id: dispute.stripeDisputeId, hours_left_at_submit: Math.round(hoursLeft) },
    outcome: "submitted",
    outcomeAt: now,
    idempotencyKey: `dispute_auto_submitted:${dispute.id}`,
  });
  // Never throws; a mail failure does not unwind the submission.
  await sendDisputeAutoSubmittedNotice(env, {
    accountId: dispute.accountId,
    disputeId: dispute.id,
    cronRunId,
  });
  return true;
}

export function describeDisputeAutoSubmitRun(r: DisputeAutoSubmitRun): string {
  return `${r.considered} due for auto-submit, ${r.submitted} submitted, ${r.failed} failed`;
}
