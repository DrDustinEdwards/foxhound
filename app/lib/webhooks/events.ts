import type Stripe from "stripe";

import { type DeclineCategory } from "~/lib/constants";
import { classifyDecline } from "~/lib/recovery/decline";

// Pure Stripe-event classification for the connected-account webhook. Maps a
// verified event to the intent the processor acts on and pulls the refs it needs
// off the event object, with NO extra Stripe calls (enrichment reads that need
// live Stripe are the processor's deferred seam). Everything here is unit-tested.
//
// Events we act on (legacy parity, trimmed to the money-critical set for 4c):
//   invoice.payment_failed     -> intake (create failed_payment + recovery steps)
//   invoice.payment_succeeded  -> recover (owns the 'recovered' status flip)
//   charge.refunded (full)     -> stamp_refund (unbills the recovery)
//   charge.dispute.created     -> stamp_dispute (feeds the billable predicate)
//   charge.dispute.closed      -> dispute_resolved (5c: won/lost state + fee snapshot)
// Everything else is ignored.

export type WebhookIntent =
  | {
      kind: "intake";
      invoiceId: string;
      customerId: string;
      customerEmail: string;
      customerName: string | null;
      amountCents: number;
      currency: string;
      declineCode: string | null;
      declineCategory: DeclineCategory;
    }
  | {
      kind: "recover";
      invoiceId: string;
      customerId: string | null;
      amountPaidCents: number;
      currency: string;
    }
  | { kind: "stamp_refund"; paymentIntentId: string }
  | { kind: "stamp_dispute"; chargeId: string }
  | { kind: "dispute_resolved"; stripeDisputeId: string; won: boolean }
  | { kind: "ignore"; reason: string };

function asId(ref: string | { id?: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id ?? null;
}

/** Classify a verified Stripe event into the processor intent. Pure. */
export function classifyStripeEvent(event: Stripe.Event): WebhookIntent {
  switch (event.type) {
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice & {
        charge?: string | { failure_code?: string } | null;
      };
      if (!invoice.id) return { kind: "ignore", reason: "no_invoice_id" };
      // $0 invoices are not recoverable revenue; skip (legacy parity).
      if ((invoice.amount_due ?? 0) === 0) return { kind: "ignore", reason: "zero_amount" };
      const declineCode =
        invoice.last_finalization_error?.decline_code ??
        (typeof invoice.charge === "object" ? invoice.charge?.failure_code : undefined) ??
        null;
      return {
        kind: "intake",
        invoiceId: invoice.id,
        customerId: asId(invoice.customer) ?? "",
        customerEmail: invoice.customer_email ?? "",
        customerName: invoice.customer_name ?? null,
        amountCents: invoice.amount_due ?? 0,
        currency: invoice.currency ?? "usd",
        declineCode,
        declineCategory: classifyDecline(declineCode),
      };
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.id) return { kind: "ignore", reason: "no_invoice_id" };
      return {
        kind: "recover",
        invoiceId: invoice.id,
        customerId: asId(invoice.customer),
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
      };
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      // Only a FULL refund unbills the recovery; a partial refund is still a
      // recovery (fee base for partials is a separate policy question).
      if (!charge.refunded) return { kind: "ignore", reason: "partial_refund" };
      const paymentIntentId = asId(charge.payment_intent);
      if (!paymentIntentId) return { kind: "ignore", reason: "no_payment_intent" };
      return { kind: "stamp_refund", paymentIntentId };
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = asId(dispute.charge);
      if (!chargeId) return { kind: "ignore", reason: "no_charge" };
      return { kind: "stamp_dispute", chargeId };
    }
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      // Only a definitive win/loss resolves our state machine. An inquiry closed
      // as warning_closed (or any other status) is not a chargeback outcome.
      if (dispute.status !== "won" && dispute.status !== "lost") {
        return { kind: "ignore", reason: "dispute_not_resolved" };
      }
      return { kind: "dispute_resolved", stripeDisputeId: dispute.id, won: dispute.status === "won" };
    }
    default:
      return { kind: "ignore", reason: "unhandled_type" };
  }
}
