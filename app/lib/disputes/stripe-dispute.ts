import type Stripe from "stripe";

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

/** The id of a Stripe field that may arrive expanded or as a bare string. */
function asId(value: string | { id?: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
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
