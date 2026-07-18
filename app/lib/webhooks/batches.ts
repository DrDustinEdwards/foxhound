import { and, eq, isNull, notInArray } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputes, failedPayments, recoveredPayments, webhookEvents } from "~/db";
import { disputeFeeCents } from "~/lib/billing/fees";
import type { DeclineCategory, DisputeState } from "~/lib/constants";
import { buildRecoveryStepInserts } from "~/lib/engine/intake";
import type { ResolvedAttribution } from "~/lib/recovery/attribution";
import { buildRecoveryBatch } from "~/lib/recovery/record-recovery";
import { planRecoverySteps } from "~/lib/recovery/schedule";

// The atomic DO batches for connected-account webhook processing. Every webhook
// side effect is committed together with the webhook_events CLAIM in ONE batch
// through the per-account money-write DO. The webhook_events unique index on
// stripe_event_id is the exactly-once key: a replay makes the claim insert fail
// the unique constraint, the whole batch rolls back, and executeMoneyWrite
// reports applied=false (idempotent no-op). Claim-with-side-effects is stronger
// than a separate claim step: there is no "claimed but not processed" gap.
//
// DEVIATION (flagged for Dustin): ARCHITECTURE.md lists a distinct webhook-claim
// DO keyed by event id. We instead fold the claim into the per-account money-write
// DO batch keyed by account_id. The exactly-once guarantee is preserved (unique
// index) and atomicity is stronger. Reconcile the canon DO count when convenient.

export interface WebhookClaimInput {
  stripeEventId: string;
  eventType: string;
  accountId: string | null;
  receivedAt: Date;
  payload: unknown;
}

/** The webhook_events claim insert. `processed: true` because it commits atomically with the side effects. */
export function buildWebhookClaim(db: Db, claim: WebhookClaimInput) {
  return db.insert(webhookEvents).values({
    stripeEventId: claim.stripeEventId,
    eventType: claim.eventType,
    receivedAt: claim.receivedAt,
    accountId: claim.accountId,
    processed: true,
    processingStartedAt: claim.receivedAt,
    payload: claim.payload ?? {},
  });
}

export interface IntakeBatchInput {
  claim: WebhookClaimInput;
  failedPaymentId: string;
  accountId: string;
  stripeEventId: string;
  invoiceId: string;
  customerId: string;
  customerEmail: string;
  customerName: string | null;
  amountCents: number;
  currency: string;
  declineCode: string | null;
  declineCategory: DeclineCategory;
  detectedAt: Date;
}

/**
 * invoice.payment_failed: claim + insert the failed_payments row (core fields;
 * ML enrichment via extra Stripe reads is a deferred seam) + the silent-first
 * recovery_steps sequence. All atomic.
 */
export function buildIntakeBatch(db: Db, input: IntakeBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  const fpInsert = db.insert(failedPayments).values({
    id: input.failedPaymentId,
    accountId: input.accountId,
    stripeEventId: input.stripeEventId,
    stripeInvoiceId: input.invoiceId,
    stripeCustomerId: input.customerId,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    amountCents: input.amountCents,
    currency: input.currency,
    declineCode: input.declineCode,
    declineCategory: input.declineCategory,
    status: "active",
    detectedAt: input.detectedAt,
    processor: "stripe",
    processorPaymentId: input.invoiceId,
    processorCustomerId: input.customerId,
  });
  const stepInserts = buildRecoveryStepInserts(
    db,
    planRecoverySteps({
      failedPaymentId: input.failedPaymentId,
      accountId: input.accountId,
      declineCategory: input.declineCategory,
      detectedAt: input.detectedAt,
    }),
  );
  return [claim, fpInsert, ...stepInserts];
}

export interface RecoverBatchInput {
  claim: WebhookClaimInput;
  accountId: string;
  failedPaymentId: string;
  amountPaidCents: number;
  currency: string;
  recoveredAt: Date;
  attribution: ResolvedAttribution;
  recoveredByStepId: string | null;
  recoveryMethod: string;
  idempotencyKey: string;
}

/**
 * invoice.payment_succeeded: claim + flip failed_payments active->recovered
 * (this webhook OWNS the recovered status, never a cron) + record the recovery
 * (recovered_payments + outcomes, attributed or free baseline). All atomic.
 * The status flip is conditional on status='active' so a replay/concurrent event
 * touches zero rows.
 */
export function buildRecoverBatch(db: Db, input: RecoverBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  const statusFlip = db
    .update(failedPayments)
    .set({ status: "recovered", resolvedAt: input.recoveredAt })
    .where(and(eq(failedPayments.id, input.failedPaymentId), eq(failedPayments.status, "active")));
  const recovery = buildRecoveryBatch(db, {
    accountId: input.accountId,
    failedPaymentId: input.failedPaymentId,
    amountCents: input.amountPaidCents,
    currency: input.currency,
    recoveredAt: input.recoveredAt,
    attribution: input.attribution,
    recoveredByStepId: input.recoveredByStepId,
    recoveryMethod: input.recoveryMethod,
    idempotencyKey: input.idempotencyKey,
  });
  return [claim, statusFlip, ...recovery];
}

/** charge.refunded (full): claim + stamp recovered_payments.refunded_at (unbills the recovery). */
export function buildRefundStampBatch(
  db: Db,
  input: { claim: WebhookClaimInput; failedPaymentId: string; at: Date },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(recoveredPayments)
      .set({ refundedAt: input.at })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, input.failedPaymentId),
          isNull(recoveredPayments.refundedAt),
        ),
      ),
  ];
}

/** charge.dispute.created: claim + stamp recovered_payments.disputed_at (feeds the billable predicate). */
export function buildDisputeStampBatch(
  db: Db,
  input: { claim: WebhookClaimInput; failedPaymentId: string; at: Date },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(recoveredPayments)
      .set({ disputedAt: input.at })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, input.failedPaymentId),
          isNull(recoveredPayments.disputedAt),
        ),
      ),
  ];
}

const RESOLVED_DISPUTE_STATES: DisputeState[] = ["resolved_won", "resolved_lost"];

export interface DisputeResolutionInput {
  claim: WebhookClaimInput;
  stripeDisputeId: string;
  won: boolean;
  /** The disputed amount, read from the existing dispute row (the fee base). */
  amountCents: number;
  currency: string;
  resolvedAt: Date;
}

/**
 * charge.dispute.closed (5c Scope B, closes review finding L1): claim + set
 * state=resolved_won|resolved_lost, conditional on the dispute not already being
 * resolved (a replay or a second close event touches zero rows, not a second
 * fee snapshot). On a win, snapshots the capped fee via disputeFeeCents onto
 * resolved_fee_cents, so getBillableDisputes stops relying on its amount
 * fallback. A loss clears any fee snapshot (defensive; a dispute never both
 * flips to lost with a stale won-fee left behind).
 */
export function buildDisputeResolutionBatch(db: Db, input: DisputeResolutionInput): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(disputes)
      .set({
        state: input.won ? "resolved_won" : "resolved_lost",
        resolvedAt: input.resolvedAt,
        resolvedFeeCents: input.won ? disputeFeeCents(input.amountCents) : null,
        resolvedFeeCurrency: input.won ? input.currency : null,
      })
      .where(
        and(
          eq(disputes.stripeDisputeId, input.stripeDisputeId),
          notInArray(disputes.state, RESOLVED_DISPUTE_STATES),
        ),
      ),
  ];
}

/** claim-only batch: a verified event we resolved to nothing actionable, still claimed so replays short-circuit. */
export function buildClaimOnlyBatch(db: Db, claim: WebhookClaimInput): MoneyWriteBatch {
  return [buildWebhookClaim(db, claim)];
}
