import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputeEvidence, disputes, failedPayments, recoveredPayments, webhookEvents } from "~/db";
import { disputeFeeCents } from "~/lib/billing/fees";
import { RECOVERABLE_FAILED_PAYMENT_STATUSES } from "~/lib/constants";
import type { DeclineCategory, DisputeState } from "~/lib/constants";
import type { EvidenceField } from "~/lib/disputes/evidence";
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
  /** The stripe_connections row this failed payment belongs to (Phase 5
   *  review MEDIUM fix companion, 2026-07-19): recorded so the card-update
   *  page (app/routes/utility/card-update.tsx) can resolve the CORRECT
   *  connection for an account with more than one, instead of an arbitrary
   *  active one. */
  stripeConnectionId: string;
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
    stripeConnectionId: input.stripeConnectionId,
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
  // Conditional so a replay or concurrent event touches zero rows. The condition
  // covers failed_unrecovered as well as active: once the exhausted-sequence
  // sweep started flipping rows, an `= 'active'` check would have quietly
  // refused to record a customer who paid after the dunning cadence ran out.
  // Widened deliberately, with findRecoverableFailedPayment as its counterpart
  // on the lookup side (both would have to be narrow for the drop to happen, and
  // both are pinned by test/cron-exhausted-sequences.test.ts).
  const statusFlip = db
    .update(failedPayments)
    .set({ status: "recovered", resolvedAt: input.recoveredAt })
    .where(
      and(
        eq(failedPayments.id, input.failedPaymentId),
        inArray(failedPayments.status, [...RECOVERABLE_FAILED_PAYMENT_STATUSES]),
      ),
    );
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

/** charge.refunded: claim + stamp recovered_payments.refunded_at (unbills the
 *  recovery). Fires on ANY refund, full or partial (parity ruling 29). The
 *  isNull guard means the FIRST refund's timestamp wins, so a second partial
 *  refund is a no-op rather than moving the disqualification later. */
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

/** The conditional recovered_payments.disputed_at stamp (feeds the billable
 *  predicate, SCHEMA.md spine #3): only touches a row that is not already
 *  stamped, so a replay or a second dispute event on the same recovery is a
 *  no-op, not a second write. Shared by buildDisputeStampBatch and
 *  buildDisputeIntakeBatch (dispute intake also excludes the underlying
 *  recovery from billing when the disputed charge is resolved to one). */
function buildDisputedAtStamp(db: Db, failedPaymentId: string, at: Date) {
  return db
    .update(recoveredPayments)
    .set({ disputedAt: at })
    .where(
      and(eq(recoveredPayments.failedPaymentId, failedPaymentId), isNull(recoveredPayments.disputedAt)),
    );
}

/** charge.dispute.created: claim + stamp recovered_payments.disputed_at (feeds the billable predicate). */
export function buildDisputeStampBatch(
  db: Db,
  input: { claim: WebhookClaimInput; failedPaymentId: string; at: Date },
): MoneyWriteBatch {
  return [buildWebhookClaim(db, input.claim), buildDisputedAtStamp(db, input.failedPaymentId, input.at)];
}

export interface DisputeIntakeInput {
  claim: WebhookClaimInput;
  disputeId: string;
  accountId: string;
  stripeConnectionId: string;
  stripeDisputeId: string;
  stripeChargeId: string;
  stripeCustomerId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  evidenceDeadline: Date | null;
  createdAt: Date;
  /** The failed_payments row this disputed charge recovered from, if the
   *  Stripe-read enrichment seam (Phase 8 live) resolved one. When set, the
   *  matching recovered_payments row is stamped disputed_at in the same
   *  atomic batch, so it is excluded from recovery billing immediately
   *  (never a separate write). */
  linkedFailedPaymentId: string | null;
  /** AI-drafted evidence, grounded only in real records (never fabricated;
   *  app/lib/disputes/evidence.ts). Empty when nothing grounds it. */
  evidence: EvidenceField[];
}

/**
 * charge.dispute.created (dispute intake, TASK-foxhound-dispute-intake.md):
 * claim + insert the disputes row (state: pending_review, "awaiting merchant
 * review", never auto-submitted) + insert the drafted dispute_evidence rows +
 * (when the disputed charge resolves to a known recovery) stamp
 * recovered_payments.disputed_at so the maturity-window billable predicate
 * excludes it. All atomic through the per-account money-write DO, same shape
 * as buildIntakeBatch/buildRecoverBatch (claim-with-side-effects).
 */
export function buildDisputeIntakeBatch(db: Db, input: DisputeIntakeInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  const disputeInsert = db.insert(disputes).values({
    id: input.disputeId,
    accountId: input.accountId,
    stripeDisputeId: input.stripeDisputeId,
    stripeChargeId: input.stripeChargeId,
    stripeCustomerId: input.stripeCustomerId,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    amountCents: input.amountCents,
    currency: input.currency,
    reason: input.reason,
    status: input.status,
    evidenceDeadline: input.evidenceDeadline,
    createdAt: input.createdAt,
    stripeConnectionId: input.stripeConnectionId,
    state: "pending_review",
  });
  const evidenceInserts = input.evidence.map((field) =>
    db.insert(disputeEvidence).values({
      id: crypto.randomUUID(),
      disputeId: input.disputeId,
      accountId: input.accountId,
      fieldName: field.fieldName,
      fieldValue: field.fieldValue,
      createdAt: input.createdAt,
    }),
  );
  const stamp = input.linkedFailedPaymentId
    ? [buildDisputedAtStamp(db, input.linkedFailedPaymentId, input.createdAt)]
    : [];
  return [claim, disputeInsert, ...evidenceInserts, ...stamp];
}

const RESOLVED_DISPUTE_STATES: DisputeState[] = ["resolved_won", "resolved_lost"];

export interface DisputeResolutionInput {
  claim: WebhookClaimInput;
  /** The account this dispute belongs to (resolved + verified at the call site).
   *  Pinned in the UPDATE WHERE so tenant isolation is DB-enforced, not
   *  caller-dependent (account-scoping audit HIGH #3), matching
   *  buildSubmissionConfirmationBatch. A foreign accountId matches zero rows. */
  accountId: string;
  stripeDisputeId: string;
  won: boolean;
  /** The disputed amount, read from the existing dispute row (the fee base). */
  amountCents: number;
  currency: string;
  /** Whether Foxhound actually drafted AND submitted the evidence for this
   *  dispute (disputes.submitted_at set). A win Foxhound did NOT submit
   *  (merchant-fought, or auto-resolved) is never billable (PRICING.md rev 3),
   *  so no fee is snapshotted for it, keeping the UI honest (resolved_fee_cents
   *  is null) alongside the authoritative getBillableDisputes gate. */
  foxhoundSubmitted: boolean;
  resolvedAt: Date;
}

/**
 * charge.dispute.closed (5c Scope B, closes review finding L1): claim + set
 * state=resolved_won|resolved_lost, conditional on the dispute not already being
 * resolved (a replay or a second close event touches zero rows, not a second
 * fee snapshot). On a win Foxhound SUBMITTED, snapshots the capped fee via
 * disputeFeeCents onto resolved_fee_cents. A win Foxhound did not submit, or a
 * loss, snapshots no fee (a lost dispute never carries a stale won-fee; a
 * merchant-fought win is never billed, PRICING.md rev 3).
 */
export function buildDisputeResolutionBatch(db: Db, input: DisputeResolutionInput): MoneyWriteBatch {
  const billableWin = input.won && input.foxhoundSubmitted;
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(disputes)
      .set({
        state: input.won ? "resolved_won" : "resolved_lost",
        resolvedAt: input.resolvedAt,
        resolvedFeeCents: billableWin ? disputeFeeCents(input.amountCents) : null,
        resolvedFeeCurrency: billableWin ? input.currency : null,
      })
      .where(
        and(
          eq(disputes.stripeDisputeId, input.stripeDisputeId),
          eq(disputes.accountId, input.accountId),
          notInArray(disputes.state, RESOLVED_DISPUTE_STATES),
        ),
      ),
  ];
}

/** claim-only batch: a verified event we resolved to nothing actionable, still claimed so replays short-circuit. */
export function buildClaimOnlyBatch(db: Db, claim: WebhookClaimInput): MoneyWriteBatch {
  return [buildWebhookClaim(db, claim)];
}
