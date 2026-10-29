import * as Sentry from "@sentry/cloudflare";
import { and, asc, eq, gt, isNotNull, isNull, lte, notExists, notInArray, sql } from "drizzle-orm";

import { accounts, disputeApprovals, disputes, getDb } from "~/db";
import { HOUR_MS } from "~/lib/constants";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { SUBMITTED_OR_RESOLVED } from "~/lib/disputes/approval";
import { sendDisputeAutoSubmittedNotice } from "~/lib/disputes/notices.server";
import { approveAndSubmitDispute, getConnectionAccessToken, getDisputeDetail } from "~/lib/disputes/queries.server";
import { recordOutcome } from "~/lib/engine/outcomes";

// DISPUTE AUTO-SUBMIT, opt-in and off by default. Recova's spec is
// app/api/cron/process-disputes/route.ts (blob 1cbd5bd0), "Thing 2": for an
// account with dispute_auto_submit on and processing not paused, an unsubmitted
// dispute in needs_response whose evidence deadline is inside the next 24
// hours is submitted to Stripe with its staged evidence, marked as submitted
// automatically, recorded as a dispute_auto_submitted outcome, and the merchant
// is told by "Dispute response submitted". One dispute's failure never stops
// the rest. It rides the dispute reminder's tick (app/lib/cron/registry.ts).
//
// THE APPROVAL GATE HOLDS (PRICING.md: no approval row, no submission). Turning
// auto-submit on is the merchant's standing approval, and the settings write
// stores who did it and when (applyDisputeSettings). This job submits through
// approveAndSubmitDispute, the same path the dispute page's Approve and submit
// uses: Phase A writes the dispute_approvals row, naming that person, with
// standing_opt_in_at set to when they opted in; Phase B submits to Stripe;
// Phase C marks the dispute submitted (submitted_by foxhound_auto) only after
// Stripe accepts. Billing reads submitted_at, so a won auto-submitted dispute is
// billed as a Foxhound submission, as Recova billed `recova_auto`. No other
// writer touches dispute_approvals or disputes' submission columns.
//
// WHO IS SUBMITTED, Recova's selection in Foxhound's vocabulary, plus Foxhound's
// own gates:
// - an open dispute nobody has submitted (submitted_at null, a state before
//   submission) that Stripe still lists as needs_response;
// - with an evidence deadline after now and no more than 24 hours away;
// - on an account with auto-submit on AND an opt-in recorded (an account whose
//   column was set any other way has no approval to stand on), Disputes on
//   (accounts.disputes_enabled), and processing eligible: not paused, not
//   canceled, never a demo account (accountProcessingEligibleCondition), so a
//   demo never reaches Stripe;
// - with a Stripe connection on the dispute;
// - with NO dispute_approvals row yet. A merchant's own approval is theirs to
//   finish from the dispute page, and an automatic attempt Stripe refused is
//   tried once, not on every five-minute tick: its approval row stays, the
//   dispute stays approvable, and the page offers Approve and submit again.
// billing_exempt is not a gate here: it decides only whether a won fee is
// invoiced, as on the manual path.

const DISPUTE_AUTO_SUBMIT_HOURS = 24;

/** Recova's CRON_BATCH_LIMIT for this query. */
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
        lte(disputes.evidenceDeadline, new Date(now.getTime() + DISPUTE_AUTO_SUBMIT_HOURS * HOUR_MS)),
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
      // Recova's per-dispute catch: log, count, go on to the next.
      result.failed++;
      console.error(`dispute auto-submit failed for dispute ${dispute.id}:`, err);
      Sentry.captureException(err, { extra: { scope: "dispute-auto-submit", disputeId: dispute.id } });
    }
  }
  return result;
}

/** One automatic submission. True when Stripe took it and it is recorded. */
async function autoSubmitOne(env: Env, now: Date, cronRunId: string | null, dispute: DueDispute): Promise<boolean> {
  const db = getDb(env);
  const token = dispute.stripeConnectionId ? await getConnectionAccessToken(db, dispute.stripeConnectionId) : null;
  const detail = await getDisputeDetail(db, dispute.accountId, dispute.id);
  if (!token || !detail || !dispute.optInEmail || !dispute.optInAt) {
    console.error(`dispute auto-submit skipped dispute ${dispute.id}: no Stripe connection or opt-in`);
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
    console.error(`dispute auto-submit refused for dispute ${dispute.id}: ${submission.message}`);
    Sentry.captureMessage("dispute auto-submit refused", {
      level: "warning",
      extra: { disputeId: dispute.id, message: submission.message },
    });
    return false;
  }

  const hoursLeft = ((dispute.evidenceDeadline?.getTime() ?? now.getTime()) - now.getTime()) / HOUR_MS;
  // Recova's outcome, keyed so it is written once.
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
  await sendDisputeAutoSubmittedNotice(env, { accountId: dispute.accountId, disputeId: dispute.id, cronRunId });
  return true;
}

export function describeDisputeAutoSubmitRun(r: DisputeAutoSubmitRun): string {
  return `${r.considered} due for auto-submit, ${r.submitted} submitted, ${r.failed} failed`;
}
