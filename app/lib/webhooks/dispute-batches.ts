import { and, eq, isNull, notInArray } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputeEvidence, disputes, failedPayments, recoveredPayments } from "~/db";
import type { ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import { disputeFeeCents, feeForCurrency } from "~/lib/billing/fees";
import type { DisputeState } from "~/lib/constants";
import type { EvidenceField } from "~/lib/disputes/evidence";
import type { DisputeContextColumns } from "~/lib/disputes/triage";

import { buildWebhookClaim, type WebhookClaimInput } from "./batches";

/**
 * The conditional recovered_payments.disputed_at stamp (feeds the billable predicate, SCHEMA.md
 * spine #3): only touches a row that is not already stamped, so a replay or a second dispute event
 * on the same recovery is a no-op, not a second write.
 */
function buildDisputedAtStamp(db: Db, accountId: string, failedPaymentId: string, at: Date) {
  return [
    // The order-independent half, as refund_signal_at is for refunds: a dispute landing BEFORE the
    // recovery row stamps the failed payment, which buildRecoveryBatch reads to be born disputed.
    db
      .update(failedPayments)
      .set({ disputeSignalAt: at })
      .where(
        and(
          eq(failedPayments.id, failedPaymentId),
          eq(failedPayments.accountId, accountId),
          isNull(failedPayments.disputeSignalAt),
        ),
      ),
    db
      .update(recoveredPayments)
      .set({ disputedAt: at })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, failedPaymentId),
          eq(recoveredPayments.accountId, accountId),
          isNull(recoveredPayments.disputedAt),
        ),
      ),
  ] as const;
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
  /**
   * The failed_payments row this disputed charge recovered from, if the Stripe-read enrichment seam
   * resolved one. When set, the matching recovered_payments row is stamped disputed_at in the same
   * atomic batch, so it is excluded from recovery billing immediately (never a separate write).
   */
  linkedFailedPaymentId: string | null;
  /** AI-drafted evidence, grounded only in real records (never fabricated;
   *  app/lib/disputes/evidence.ts). Empty when nothing grounds it. */
  evidence: EvidenceField[];
  /** Absent on a caller that read nothing. */
  contextColumns?: DisputeContextColumns;
}

/**
 * charge.dispute.created (dispute intake): claim + insert the
 * disputes row (state: pending_review, "awaiting merchant review", never auto-submitted) + insert
 * the drafted dispute_evidence rows + (when the disputed charge resolves to a known recovery) stamp
 * recovered_payments.disputed_at so the maturity-window billable predicate excludes it. All atomic
 * through the per-account money-write DO, as buildIntakeBatch and buildRecoverBatch.
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
    // A dispute Stripe has already closed (its closed event came first, or this is a late
    // retry) is born resolved, so it is never left awaiting review or picked up by auto-submit.
    ...(input.status === "won" || input.status === "lost"
      ? {
          state: input.status === "won" ? ("resolved_won" as const) : ("resolved_lost" as const),
          resolvedAt: input.claim.receivedAt,
        }
      : { state: "pending_review" as const }),
    ...input.contextColumns,
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
    ? buildDisputedAtStamp(db, input.accountId, input.linkedFailedPaymentId, input.createdAt)
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
  /** The USD 500 cap in THIS dispute's currency, converted at resolution.
   * Null when the quote failed, which is the fail-closed
   *  case: no fee is snapshotted. */
  cap: ResolvedDisputeCap | null;
  /** Why the cap could not be resolved, stored on the row so the dispute's
   *  unbilled state has a stated reason rather than looking like a win nobody
   *  charged for. */
  capError: string | null;
  /**
   * Whether Foxhound actually drafted AND submitted the evidence for this dispute
   * (disputes.submitted_at set). A win Foxhound did NOT submit (merchant-fought, or auto-resolved)
   * is never billable (PRICING.md rev 3), so no fee is snapshotted for it, keeping the UI honest
   * (resolved_fee_cents is null) alongside the authoritative getBillableDisputes gate.
   */
  foxhoundSubmitted: boolean;
  resolvedAt: Date;
}

/**
 * charge.dispute.closed: claim + set state=resolved_won|resolved_lost, conditional on the dispute
 * not already being resolved (a replay or a second close event touches zero rows, not a second fee
 * snapshot). A win Foxhound did not submit, or a loss, snapshots no fee (a lost dispute never
 * carries a stale won-fee; a merchant-fought win is never billed, PRICING.md rev 3).
 */
export function buildDisputeResolutionBatch(
  db: Db,
  input: DisputeResolutionInput,
): MoneyWriteBatch {
  return [buildWebhookClaim(db, input.claim), buildDisputeResolutionUpdate(db, input)];
}

/**
 * The resolution UPDATE itself, the one writer of a dispute's resolved state and fee snapshot.
 * buildDisputeResolutionBatch rides it behind the webhook claim, unchanged; the merchant's Accept
 * (app/lib/disputes/accept.server.ts) rides it as a loss Foxhound did not submit, so an accepted
 * dispute is resolved by the same statement Stripe's closing event would have used, with no fee.
 */
export function buildDisputeResolutionUpdate(db: Db, input: Omit<DisputeResolutionInput, "claim">) {
  const billableWin = input.won && input.foxhoundSubmitted;
  return db
    .update(disputes)
    .set({
      state: input.won ? "resolved_won" : "resolved_lost",
      resolvedAt: input.resolvedAt,
      // THE CAP IS RESOLVED BEFORE THIS BATCH IS BUILT. It needs a Stripe FX quote, and an external
      // call cannot live inside the money batch, so process.ts fetches it and hands the result in.
      // A failed quote arrives as a null cap and the fee is NOT snapshotted: the dispute resolves,
      // and is not billable until a run that can price it. Never the flat 50,000.
      resolvedFeeCents:
        billableWin && input.cap
          ? feeForCurrency(
              disputeFeeCents(input.amountCents, input.cap.capMinorUnits),
              input.currency,
            )
          : null,
      resolvedFeeCurrency: billableWin && input.cap ? input.currency : null,
      resolvedFeeRate: input.cap?.rate ?? null,
      resolvedFeeQuoteId: input.cap?.quoteId ?? null,
      resolvedFeeRateAt: input.cap?.quotedAt ?? null,
      resolvedFeeError: input.capError ?? null,
    })
    .where(
      and(
        eq(disputes.stripeDisputeId, input.stripeDisputeId),
        eq(disputes.accountId, input.accountId),
        notInArray(disputes.state, RESOLVED_DISPUTE_STATES),
      ),
    );
}
