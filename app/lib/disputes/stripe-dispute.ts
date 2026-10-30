import type Stripe from "stripe";

import { asId } from "~/lib/stripe/ids";

// The ONE mapping from a Stripe.Dispute object to the fields dispute intake
// writes, shared by the two callers that produce one.
//
// Extracted under ruling 400. Before it, the mapping lived inline in
// app/lib/webhooks/events.ts's `charge.dispute.created` case and had exactly one
// caller. The manual import (400 halt ruling 1) is the second, and it reads a
// Stripe.Dispute retrieved directly rather than one delivered on an event. Two
// copies of "which Stripe field becomes which column, and what it falls back to"
// is how a manually imported dispute would quietly stop resembling a
// webhook-imported one; the whole point of 400's ruling is that the two
// converge, so the mapping is one function and both paths call it.
//
// Pure: no clock except the explicit `now` fallback, no network, no env.

/** Stripe dispute ids are prefixed `dp_`. Legacy validates this in the browser
 *  only (SyncDisputeLink.tsx: `if (!trimmed.startsWith('dp_'))`), which is a
 *  hint and not a check, because an action takes whatever is posted. Same
 *  reasoning as S30's lookback clamp moving server-side. */
export function isStripeDisputeId(value: string): boolean {
  return /^dp_[A-Za-z0-9_]+$/.test(value);
}

export interface DisputeIntakeFields {
  stripeDisputeId: string;
  chargeId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  evidenceDeadline: Date | null;
  createdAt: Date;
}

/**
 * The intake fields for a dispute, or null when it carries no charge to attach
 * to (the webhook parser's `no_charge` ignore, expressed as an absent result so
 * both callers must handle it).
 *
 * `now` is injected rather than read, so the `createdAt` fallback for a dispute
 * with no `created` is testable and the function stays pure.
 */
export function disputeIntakeFields(
  dispute: Stripe.Dispute,
  now: Date,
): DisputeIntakeFields | null {
  const chargeId = asId(dispute.charge);
  if (!chargeId) return null;
  if (!dispute.id) return null;
  return {
    stripeDisputeId: dispute.id,
    chargeId,
    paymentIntentId: asId(dispute.payment_intent),
    amountCents: dispute.amount ?? 0,
    currency: dispute.currency ?? "usd",
    reason: dispute.reason ?? "general",
    status: dispute.status ?? "needs_response",
    evidenceDeadline: dispute.evidence_details?.due_by
      ? new Date(dispute.evidence_details.due_by * 1000)
      : null,
    createdAt: dispute.created ? new Date(dispute.created * 1000) : now,
  };
}

/** What charge.dispute.updated keeps current on the stored row. */
export interface DisputeLiveFields {
  stripeDisputeId: string;
  status: string;
  evidenceDeadline: Date | null;
  hasEvidence: boolean;
  submissionCount: number;
  amountCents: number;
  reason: string;
}

/** The live fields of a dispute, with intake's fallbacks, or null with no id. */
export function disputeLiveFields(dispute: Stripe.Dispute): DisputeLiveFields | null {
  if (!dispute.id) return null;
  return {
    stripeDisputeId: dispute.id,
    status: dispute.status ?? "needs_response",
    evidenceDeadline: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
    hasEvidence: dispute.evidence_details?.has_evidence ?? false,
    submissionCount: dispute.evidence_details?.submission_count ?? 0,
    amountCents: dispute.amount ?? 0,
    reason: dispute.reason ?? "general",
  };
}

type DisputeFundsKind = "withdrawn" | "reinstated";

export interface DisputeFundsMovement {
  stripeBalanceTransactionId: string;
  kind: DisputeFundsKind;
  /** Signed as Stripe signs it: negative when funds left the balance. */
  amountCents: number;
  /** Stripe's dispute fee on this transaction: positive when debited,
   *  negative when returned. */
  feeCents: number;
  currency: string;
  occurredAt: Date;
}

/**
 * The money Stripe moved for a dispute, read off dispute.balance_transactions,
 * which Stripe always sends expanded on the dispute object (so no Stripe call).
 * Stripe reports a withdrawal under the reporting category `dispute` and a
 * reinstatement under `dispute_reversal`; any other category falls back to the
 * sign, money out being a withdrawal.
 */
export function disputeFundsMovements(dispute: Stripe.Dispute): DisputeFundsMovement[] {
  const transactions = (dispute.balance_transactions ?? []) as (Stripe.BalanceTransaction | string)[];
  const movements: DisputeFundsMovement[] = [];
  for (const bt of transactions) {
    if (typeof bt === "string" || !bt.id) continue;
    const amountCents = bt.amount ?? 0;
    const kind: DisputeFundsKind =
      bt.reporting_category === "dispute_reversal"
        ? "reinstated"
        : bt.reporting_category === "dispute" || amountCents < 0
          ? "withdrawn"
          : "reinstated";
    movements.push({
      stripeBalanceTransactionId: bt.id,
      kind,
      amountCents,
      feeCents: bt.fee ?? 0,
      currency: bt.currency ?? dispute.currency ?? "usd",
      occurredAt: new Date((bt.created ?? 0) * 1000),
    });
  }
  return movements;
}
