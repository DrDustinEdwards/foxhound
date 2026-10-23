// Dispute intents of the connected-account webhook: intake and resolution.
// Dispatched from process.ts.

import { and, eq, isNull } from "drizzle-orm";
import { disputes, getDb } from "~/db";
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { isDisputeResolved } from "~/lib/disputes/labels";
import { sendDisputeCreatedNotice, sendDisputeOutcomeNotice } from "~/lib/disputes/notices.server";
import { readDisputeProductDescription } from "~/lib/disputes/queries.server";
import { resolveDisputeCap, type ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import { DISPUTE_CREDIT_DESCRIPTION, issueCreditNoteForEvidence } from "~/lib/billing/credit-note";
import { executeMoneyWrite } from "~/lib/money/execute";

import {
  buildClaimOnlyBatch,
  buildDisputeIntakeBatch,
  buildDisputeResolutionBatch,
} from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";
import { findDisputeByStripeId, resolveDisputedRecovery } from "./lookups";

/**
 * Send the won or lost notice for a resolved dispute and, when it went out,
 * stamp disputes.outcome_notified_at, the timeline's "Outcome notification
 * sent." Recova stamped it after its send too. The stamp is its own small batch
 * through the money-write Durable Object, keyed on the dispute and guarded on
 * the column still being empty, so it is written once and never moves; the
 * notice module itself writes nothing (RULES.md 3.2). Never throws.
 */
async function notifyDisputeOutcome(env: Env, accountId: string, disputeId: string): Promise<void> {
  const notice = await sendDisputeOutcomeNotice(env, { accountId, disputeId });
  if (notice.kind !== "sent" || notice.result.status !== "sent") return;
  try {
    await executeMoneyWrite(env, {
      accountId,
      idempotencyKey: `dispute-outcome-notified:${disputeId}`,
      build: (db) => [
        db
          .update(disputes)
          .set({ outcomeNotifiedAt: new Date() })
          .where(
            and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId), isNull(disputes.outcomeNotifiedAt)),
          ),
      ],
    });
  } catch (err) {
    console.error(`dispute ${disputeId}: outcome_notified_at stamp failed after the notice was sent`, err);
  }
}

export async function handleStampDispute(
  ctx: WebhookContext,
  intent: IntentOf<"stamp_dispute">,
): Promise<WebhookOutcome> {
  const { env, accountId, connectionId, claim, idempotencyKey } = ctx;
  // charge.dispute.created (dispute intake): resolve the recovery this
  // charge belongs to (if any, the Phase 8-live enrichment seam above),
  // draft evidence grounded only in what that resolution and our own
  // recovery_steps actually show, and create the dispute row, "awaiting
  // merchant review" (state pending_review), never auto-submitted.
  const linked = await resolveDisputedRecovery(env, accountId, connectionId, intent.paymentIntentId);
  const facts = buildEvidenceFacts(
    linked?.failedPayment ?? null,
    linked?.steps ?? [],
    await readDisputeProductDescription(getDb(env), accountId),
  );
  const evidence = await draftDisputeEvidence(env, facts);
  const disputeId = crypto.randomUUID();
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildDisputeIntakeBatch(db, {
        claim,
        disputeId,
        accountId,
        stripeConnectionId: connectionId,
        stripeDisputeId: intent.stripeDisputeId,
        stripeChargeId: intent.chargeId,
        stripeCustomerId: linked?.failedPayment.stripeCustomerId ?? null,
        customerEmail: linked?.failedPayment.customerEmail ?? null,
        customerName: linked?.failedPayment.customerName ?? null,
        amountCents: intent.amountCents,
        currency: intent.currency,
        reason: intent.reason,
        status: intent.status,
        evidenceDeadline: intent.evidenceDeadline,
        createdAt: intent.createdAt,
        linkedFailedPaymentId: linked?.failedPayment.id ?? null,
        evidence,
      }),
  });
  // THE NEW-DISPUTE NOTICE (J06), after the intake has committed and
  // changing nothing about it, as the recovery notification above. Recova
  // sends it at the end of handleDisputeCreated. It never throws.
  //
  // SENT ON A REDELIVERY TOO (PR 149 review). A Worker that dies between
  // the intake commit and the send leaves the merchant untold, and Stripe's
  // redelivery comes back `applied: false`. So a replay sends for the row
  // that exists; the notice's send claim (`dispute-created:<row id>`) is
  // what keeps it to one email, not `applied`.
  const noticeFor = applied
    ? disputeId
    : await findDisputeByStripeId(env, intent.stripeDisputeId).then(
        (row) => (row && row.accountId === accountId ? row.id : null),
        (err) => {
          console.error("dispute notice lookup on a redelivery failed", err);
          return null;
        },
      );
  if (noticeFor) {
    await sendDisputeCreatedNotice(env, { accountId, disputeId: noticeFor });
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleDisputeResolved(
  ctx: WebhookContext,
  intent: IntentOf<"dispute_resolved">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  // The dispute row normally exists by now (stamp_dispute intake runs on
  // the earlier charge.dispute.created event). A miss is defensive, not
  // expected: a safe claim-only ignore, never a throw.
  const dispute = await findDisputeByStripeId(env, intent.stripeDisputeId);
  if (!dispute || dispute.accountId !== accountId) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied ? { status: "ignored", reason: "dispute_not_found" } : { status: "duplicate" };
  }
  if (isDisputeResolved(dispute.state)) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    // A dispute the merchant ACCEPTED is resolved before Stripe's closing
    // event arrives. Recova still sent its lost notice on that event
    // (handleDisputeClosed, gated on outcome_notified_at), so this does
    // too; the notice's send claim keeps it to one per dispute.
    if (applied) await notifyDisputeOutcome(env, accountId, dispute.id);
    return applied ? { status: "ignored", reason: "already_resolved" } : { status: "duplicate" };
  }
  // THE CAP IS CONVERTED HERE, BEFORE THE BATCH (ruling 377(7)). It needs a
  // Stripe FX quote and an external call cannot ride the money batch. A
  // failure is recorded and the fee is left unsnapshotted, which is the
  // fail-closed shape: the dispute resolves either way, and an unpriced win
  // is simply not billable until it can be priced. The old flat 50,000 is
  // never used as a fallback, because a wrong number invoiced silently is
  // worse than a right one invoiced late.
  let cap: ResolvedDisputeCap | null = null;
  let capError: string | null = null;
  if (intent.won && dispute.submittedAt != null) {
    try {
      cap = await resolveDisputeCap(env, dispute.currency, receivedAt);
    } catch (err) {
      capError = err instanceof Error ? err.message : "fx quote failed";
    }
  }

  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildDisputeResolutionBatch(db, {
        claim,
        accountId,
        stripeDisputeId: intent.stripeDisputeId,
        won: intent.won,
        amountCents: dispute.amountCents,
        currency: dispute.currency,
        cap,
        capError,
        // A fee is snapshotted only if Foxhound actually submitted this
        // dispute (submitted_at set post-Stripe). A merchant-fought or
        // auto-resolved win carries no fee (PRICING.md rev 3).
        foxhoundSubmitted: dispute.submittedAt != null,
        resolvedAt: receivedAt,
      }),
  });

  // A dispute Foxhound WON, billed, and then lost on reopening is the
  // 120-day case maturity cannot reach (377(5)). Same shape as the refund
  // above: after the commit, never unwinding it, keyed on the fee line.
  if (applied && !intent.won) {
    await issueCreditNoteForEvidence(
      env,
      { disputeId: dispute.id },
      { now: receivedAt, description: DISPUTE_CREDIT_DESCRIPTION },
    );
  }
  // THE WON OR LOST NOTICE (J06), after the resolution has committed.
  if (applied) await notifyDisputeOutcome(env, accountId, dispute.id);
  return applied ? { status: "applied" } : { status: "duplicate" };
}
