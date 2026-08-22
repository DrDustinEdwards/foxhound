import type Stripe from "stripe";

import { type DeclineCategory } from "~/lib/constants";
import { readWinbackSequenceId } from "~/lib/recovery/winback-metadata";
import { classifyDecline } from "~/lib/recovery/decline";

// Pure Stripe-event classification for the connected-account webhook. Maps a
// verified event to the intent the processor acts on and pulls the refs it needs
// off the event object, with NO extra Stripe calls (enrichment reads that need
// live Stripe are the processor's deferred seam). Everything here is unit-tested.
//
// Events we act on (legacy parity, trimmed to the money-critical set for 4c):
//   invoice.payment_failed     -> intake (create failed_payment + recovery steps)
//   invoice.payment_succeeded  -> recover (owns the 'recovered' status flip)
//   charge.refunded            -> stamp_refund (unbills the recovery, any refund)
//   charge.dispute.created     -> stamp_dispute (dispute intake; feeds the billable predicate)
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
      /** The invoice's subscription, when it has one. A win-back reactivation
       *  is read off THIS subscription's metadata (344 binding 1). */
      subscriptionId: string | null;
      amountPaidCents: number;
      currency: string;
    }
  | {
      /** A Checkout Session completed carrying a win-back sequence id, which is
       *  the EXACT reactivation signal: the session Foxhound created on the
       *  resubscribe click carries the id in its own metadata (344). */
      kind: "winback_reactivate";
      sequenceId: string;
    }
  | { kind: "stamp_refund"; paymentIntentId: string }
  | {
      kind: "stamp_dispute";
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
  | { kind: "dispute_resolved"; stripeDisputeId: string; won: boolean }
  | {
      kind: "winback_start";
      subscriptionId: string;
      customerId: string;
      cancelReason: string | null;
      planName: string | null;
      amountCents: number | null;
      currency: string | null;
    }
  | {
      /** customer.updated carrying a card inside the expiring-card lead window.
       *  Legacy's handleCustomerUpdated is the spec: it RECORDS a candidate and
       *  never sends, the nightly cron owning every send. */
      kind: "record_expiring_card";
      customerId: string;
      customerEmail: string;
      customerName: string | null;
      /** The card, when the event already carries it. */
      card: { expMonth: number; expYear: number; brand: string | null; last4: string | null } | null;
      /** Otherwise the payment method to retrieve, per this file's rule that the
       *  classifier makes no Stripe call. */
      paymentMethodId: string | null;
    }
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
        // On the pinned API version the invoice no longer types `subscription`,
        // and legacy reads it through the same cast.
        subscriptionId: asId(
          (invoice as Stripe.Invoice & { subscription?: string | { id: string } | null })
            .subscription,
        ),
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
      };
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      // ANY refund disqualifies the recovery from billing, full or partial, with
      // no proration (parity ruling 29: conservative and merchant-favorable,
      // and there is no credit-note subsystem to unwind a fee after the fact).
      // This used to gate on charge.refunded (full refunds only), which left a
      // partially-refunded recovery fully billable.
      const paymentIntentId = asId(charge.payment_intent);
      if (!paymentIntentId) return { kind: "ignore", reason: "no_payment_intent" };
      return { kind: "stamp_refund", paymentIntentId };
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = asId(dispute.charge);
      if (!chargeId) return { kind: "ignore", reason: "no_charge" };
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      return {
        kind: "stamp_dispute",
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
        createdAt: dispute.created ? new Date(dispute.created * 1000) : new Date(),
      };
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
    case "customer.subscription.deleted": {
      // Win-back intake (290). Legacy's handleSubscriptionDeleted is the spec.
      // Everything reachable WITHOUT a Stripe call is pulled here, per this
      // file's own no-extra-calls rule; the customer EMAIL is not on the
      // subscription object and legacy fetches it separately, so that read and
      // legacy's `if (!customerEmail) return` gate live in the processor.
      const subscription = event.data.object as Stripe.Subscription;
      if (!subscription.id) return { kind: "ignore", reason: "no_subscription_id" };
      const customerId = asId(subscription.customer);
      if (!customerId) return { kind: "ignore", reason: "no_customer" };
      // Legacy reads plan, amount and currency off the FIRST subscription item's
      // price, and tolerates all three being absent.
      const price = subscription.items?.data?.[0]?.price ?? null;
      const product = price?.product;
      return {
        kind: "winback_start",
        subscriptionId: subscription.id,
        customerId,
        cancelReason: subscription.cancellation_details?.reason ?? null,
        planName:
          product && typeof product !== "string" && "name" in product
            ? ((product as Stripe.Product).name ?? null)
            : null,
        amountCents: price?.unit_amount ?? null,
        currency: price?.currency ?? null,
      };
    }
    case "checkout.session.completed": {
      // The reactivation's PRIMARY path, and the only one that needs no Stripe
      // read: Foxhound put the sequence id on this session itself when the
      // customer clicked the resubscribe button (344).
      const session = event.data.object as Stripe.Checkout.Session;
      const sequenceId = readWinbackSequenceId(session.metadata);
      if (!sequenceId) return { kind: "ignore", reason: "not_a_winback_checkout" };
      return { kind: "winback_reactivate", sequenceId };
    }
    case "customer.updated": {
      // Legacy reads the card from the deprecated `sources` array first and
      // falls back to retrieving `invoice_settings.default_payment_method`.
      // Both halves are reproduced, the retrieve deferred to the processor
      // because this function makes no Stripe call (the same split
      // customer.subscription.deleted takes for the customer email).
      const customer = event.data.object as Stripe.Customer;
      if (!customer.id) return { kind: "ignore", reason: "no_customer" };
      const email = customer.email ?? "";
      if (!email) return { kind: "ignore", reason: "no_customer_email" };

      const sources = (customer as Stripe.Customer & {
        sources?: { data?: { object?: string; exp_month?: number; exp_year?: number; brand?: string; last4?: string }[] };
      }).sources?.data;
      const source = sources?.[0];
      if (source && source.object === "card" && source.exp_month && source.exp_year) {
        return {
          kind: "record_expiring_card",
          customerId: customer.id,
          customerEmail: email,
          customerName: customer.name ?? null,
          card: {
            expMonth: source.exp_month,
            expYear: source.exp_year,
            brand: source.brand ?? null,
            last4: source.last4 ?? null,
          },
          paymentMethodId: null,
        };
      }

      const defaultPm = customer.invoice_settings?.default_payment_method;
      const pmId = asId(defaultPm);
      if (!pmId) return { kind: "ignore", reason: "no_card_on_customer" };
      return {
        kind: "record_expiring_card",
        customerId: customer.id,
        customerEmail: email,
        customerName: customer.name ?? null,
        card: null,
        paymentMethodId: pmId,
      };
    }
    default:
      return { kind: "ignore", reason: "unhandled_type" };
  }
}
