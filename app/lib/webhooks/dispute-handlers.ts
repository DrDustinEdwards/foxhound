// Dispute intents of the connected-account webhook: intake and resolution.
// Dispatched from process.ts.

import { and, eq, isNull } from "drizzle-orm";
import { disputes, getDb } from "~/db";
import { mergeEvidence, readDisputeIntakeContext } from "~/lib/disputes/context.server";
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { isDisputeResolved } from "~/lib/disputes/labels";
import { sendDisputeCreatedNotice, sendDisputeOutcomeNotice } from "~/lib/disputes/notices.server";
import { readDisputeProductDescription, readDisputesEnabled } from "~/lib/disputes/queries.server";
import { resolveDisputeCap, type ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import {
  CHARGEBACK_CREDIT_DESCRIPTION,
  DISPUTE_CREDIT_DESCRIPTION,
  disputedRecoveryIdsFor,
  issueCreditNoteForEvidence,
} from "~/lib/billing/credit-note";
import { executeMoneyWrite } from "~/lib/money/execute";

import {
  buildClaimOnlyBatch,
  buildDisputeIntakeBatch,
  buildDisputeResolutionBatch,
} from "./batches";
import {
  claimOnly,
  type IntentOf,
  type WebhookContext,
  type WebhookOutcome,
} from "./handler-context";
import { findDisputeByStripeId, resolveDisputedRecovery } from "./lookups";

/**
 * The stamp is its own small batch through the money-write Durable Object, keyed on the dispute and
 * guarded on the column still being empty, so it is written once and never moves; the notice module
 * itself writes nothing. Never throws.
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
            and(
              eq(disputes.id, disputeId),
              eq(disputes.accountId, accountId),
              isNull(disputes.outcomeNotifiedAt),
            ),
          ),
      ],
    });
  } catch (err) {
    console.error(
      `dispute ${disputeId}: outcome_notified_at stamp failed after the notice was sent`,
      err,
    );
  }
}

export async function handleStampDispute(
  ctx: WebhookContext,
  intent: IntentOf<"stamp_dispute">,
): Promise<WebhookOutcome> {
  const { env, accountId, connectionId, claim, idempotencyKey } = ctx;
  // The claim still commits, so a redelivery stays a duplicate.
  if (!(await readDisputesEnabled(getDb(env), accountId))) {
    console.log(
      `dispute ${intent.stripeDisputeId}: Disputes is off for account ${accountId}; not created`,
    );
    return claimOnly(ctx, "disputes_disabled");
  }
  // charge.dispute.created (dispute intake): resolve the recovery this charge belongs to, draft
  // evidence grounded only in what that resolution and our own recovery_steps actually show, and
  // create the dispute row, "awaiting merchant review" (state pending_review), never
  // auto-submitted.
  const linked = await resolveDisputedRecovery(
    env,
    accountId,
    connectionId,
    intent.paymentIntentId,
  );
  const facts = buildEvidenceFacts(
    linked?.failedPayment ?? null,
    linked?.steps ?? [],
    await readDisputeProductDescription(getDb(env), accountId),
  );
  const stripeContext = await readDisputeIntakeContext(env, {
    accountId,
    connectionId,
    stripeDisputeId: intent.stripeDisputeId,
    chargeId: intent.chargeId,
    customerId: linked?.failedPayment.stripeCustomerId ?? null,
    amountCents: intent.amountCents,
    reason: intent.reason,
  });
  const evidence = mergeEvidence(
    stripeContext.evidence,
    await draftDisputeEvidence(env, facts, {
      source: "dispute_evidence",
      accountId,
      relatedId: intent.stripeDisputeId,
    }),
  );
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
        stripeCustomerId:
          linked?.failedPayment.stripeCustomerId ?? stripeContext.context.customerId,
        customerEmail: linked?.failedPayment.customerEmail ?? stripeContext.context.customerEmail,
        customerName: linked?.failedPayment.customerName ?? stripeContext.context.customerName,
        amountCents: intent.amountCents,
        currency: intent.currency,
        reason: intent.reason,
        status: intent.status,
        evidenceDeadline: intent.evidenceDeadline,
        createdAt: intent.createdAt,
        linkedFailedPaymentId: linked?.failedPayment.id ?? null,
        evidence,
        contextColumns: stripeContext.columns,
      }),
  });
  // THE NEW-DISPUTE NOTICE, after the intake has committed and changing nothing about it, as the
  // recovery notification above.
  const noticeFor = applied
    ? disputeId
    : await findDisputeByStripeId(env, accountId, intent.stripeDisputeId).then(
        (row) => row?.id ?? null,
        (err) => {
          console.error("dispute notice lookup on a redelivery failed", err);
          return null;
        },
      );
  if (noticeFor) {
    await sendDisputeCreatedNotice(env, { accountId, disputeId: noticeFor });
  }
  // A CHARGEBACK ON A RECOVERED PAYMENT credits that recovery's fee if it was already invoiced,
  // keyed on the fee line exactly as a refund is, so a refund and a dispute on the same payment
  // still credit it once. Only on `applied`, as the refund path: a failure here is picked up by the
  // daily credit-note-retry sweep, which reads the same disputed_at stamp.
  if (applied && linked) {
    for (const recoveredPaymentId of await disputedRecoveryIdsFor(env, linked.failedPayment.id)) {
      await issueCreditNoteForEvidence(
        env,
        { recoveredPaymentId },
        { now: intent.createdAt, description: CHARGEBACK_CREDIT_DESCRIPTION },
      );
    }
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleDisputeResolved(
  ctx: WebhookContext,
  intent: IntentOf<"dispute_resolved">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  const dispute = await findDisputeByStripeId(env, accountId, intent.stripeDisputeId);
  if (!dispute) {
    // Out-of-order delivery (closed before created): claiming would mark the event handled and the
    // dispute would stay open for good, so leave it unclaimed for Stripe's retry and the missed-event
    // sweep. An account with Disputes off never creates the row, so there it is a claim-only ignore.
    if (!(await readDisputesEnabled(getDb(env), accountId))) {
      return claimOnly(ctx, "disputes_disabled");
    }
    return { status: "error", message: "dispute_not_found" };
  }
  if (isDisputeResolved(dispute.state)) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    // A dispute the merchant ACCEPTED is resolved before Stripe's closing event arrives.
    if (applied) await notifyDisputeOutcome(env, accountId, dispute.id);
    return applied ? { status: "ignored", reason: "already_resolved" } : { status: "duplicate" };
  }
  // THE CAP IS CONVERTED HERE, BEFORE THE BATCH. It needs a Stripe FX quote and an external call
  // cannot ride the money batch. A failure is recorded and the fee is left unsnapshotted, which is
  // the fail-closed shape: the dispute resolves either way, and an unpriced win is simply not
  // billable until it can be priced. The old flat 50,000 is never used as a fallback, because a
  // wrong number invoiced silently is worse than a right one invoiced late.
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

  // A lost dispute credits any fee line it carries, after the commit, never unwinding it, keyed on
  // the fee line. So a fee is billed only on a won dispute, and this credit finds nothing to credit
  // on a dispute that reaches here unresolved.
  if (applied && !intent.won) {
    await issueCreditNoteForEvidence(
      env,
      { disputeId: dispute.id },
      { now: receivedAt, description: DISPUTE_CREDIT_DESCRIPTION },
    );
  }
  // THE WON OR LOST NOTICE, after the resolution has committed.
  if (applied) await notifyDisputeOutcome(env, accountId, dispute.id);
  return applied ? { status: "applied" } : { status: "duplicate" };
}
