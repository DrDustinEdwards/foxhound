import type Stripe from "stripe";

import {
  disputeFundsMovements,
  disputeIntakeFields,
  disputeLiveFields,
} from "~/lib/disputes/stripe-dispute";

import { detectSubscriptionChanges } from "~/lib/intelligence/subscription-change";
import { readWinbackSequenceId } from "~/lib/recovery/winback-metadata";
import { classifyDecline } from "~/lib/recovery/decline";
import { readAccountHealth } from "~/lib/stripe/account-health";
import { asId } from "~/lib/stripe/ids";
import { stripeDate } from "~/lib/stripe/time";

import type { WebhookIntent } from "./intent";

// Pure Stripe-event classification for the connected-account webhook. Everything here is
// unit-tested.

/** Stripe's card updater replaced the card details (a new expiry or number
 *  from the network). Whether the customer has a payment to retry is the
 *  processor's question. */
function cardAutoUpdated(paymentMethod: Stripe.PaymentMethod): WebhookIntent {
  const customerId = asId(paymentMethod.customer);
  if (!customerId) return { kind: "ignore", reason: "no_customer" };
  return { kind: "card_auto_updated", customerId };
}

/** A subscription's id and customer id, or the ignore intent for the one that is missing. */
function subscriptionRefs(
  subscription: Stripe.Subscription,
): { id: string; customerId: string } | WebhookIntent {
  if (!subscription.id) return { kind: "ignore", reason: "no_subscription_id" };
  const customerId = asId(subscription.customer);
  if (!customerId) return { kind: "ignore", reason: "no_customer" };
  return { id: subscription.id, customerId };
}

/** Classify a verified Stripe event into the processor intent. Pure. */
export function classifyStripeEvent(event: Stripe.Event): WebhookIntent {
  // Stripe's name for payment_method.automatically_updated before 2020-08-27, with the same
  // PaymentMethod payload.
  if ((event.type as string) === "payment_method.card_automatically_updated") {
    return cardAutoUpdated(event.data.object as Stripe.PaymentMethod);
  }
  switch (event.type) {
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.id) return { kind: "ignore", reason: "no_invoice_id" };
      // An invoice the customer pays by hand (send_invoice) has no card to
      // retry and no Smart Retries; its "failure" is not a decline.
      if (invoice.collection_method !== "charge_automatically") {
        return { kind: "ignore", reason: "not_charged_automatically" };
      }
      // $0 invoices are not recoverable revenue; skip.
      if ((invoice.amount_due ?? 0) === 0) return { kind: "ignore", reason: "zero_amount" };
      // Only what the event carries, which on the pinned API version is a finalization failure at
      // most (the invoice has no `charge`).
      const declineCode = invoice.last_finalization_error?.decline_code ?? null;
      return {
        kind: "intake",
        // Stripe sends `next_payment_attempt` as a unix timestamp while it
        // still intends to retry, and null once it has stopped. Absent is
        // treated as null, which is the same thing Stripe means by it.
        stripeGaveUp: (invoice.next_payment_attempt ?? null) === null,
        invoiceId: invoice.id,
        customerId: asId(invoice.customer) ?? "",
        subscriptionId: asId(invoice.parent?.subscription_details?.subscription),
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
        // On the pinned API version the subscription lives under `parent`;
        // the top-level `subscription` field is gone.
        subscriptionId: asId(invoice.parent?.subscription_details?.subscription),
        paidAt: stripeDate(invoice.status_transitions?.paid_at ?? event.created),
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
      };
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      // The fee shrinks by the refunded share and a full refund owes none.
      const paymentIntentId = asId(charge.payment_intent);
      if (!paymentIntentId) return { kind: "ignore", reason: "no_payment_intent" };
      return {
        kind: "stamp_refund",
        paymentIntentId,
        refundedCents: charge.amount_refunded ?? 0,
        full: charge.refunded === true,
      };
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      // Shared with the manual import (app/lib/disputes/stripe-dispute.ts): both intake paths must
      // produce the same row from the same object.
      const fields = disputeIntakeFields(dispute, new Date());
      if (!fields) return { kind: "ignore", reason: "no_charge" };
      return { kind: "stamp_dispute", ...fields };
    }
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      // Only a definitive win/loss resolves our state machine. An inquiry closed
      // as warning_closed is not a chargeback outcome: it closes the inquiry,
      // with nothing won, lost or billable. Any other status is ignored.
      if (dispute.status === "warning_closed")
        return { kind: "inquiry_closed", stripeDisputeId: dispute.id };
      if (dispute.status !== "won" && dispute.status !== "lost") {
        return { kind: "ignore", reason: "dispute_not_resolved" };
      }
      return {
        kind: "dispute_resolved",
        stripeDisputeId: dispute.id,
        won: dispute.status === "won",
      };
    }
    case "charge.dispute.updated": {
      const fields = disputeLiveFields(event.data.object as Stripe.Dispute);
      if (!fields) return { kind: "ignore", reason: "no_dispute_id" };
      return {
        kind: "dispute_updated",
        ...fields,
        eventCreatedAt: stripeDate(event.created),
        funds: disputeFundsMovements(event.data.object as Stripe.Dispute),
      };
    }
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      return {
        kind: "dispute_funds",
        stripeDisputeId: dispute.id,
        funds: disputeFundsMovements(dispute),
      };
    }
    case "customer.subscription.deleted": {
      // Win-back intake.
      const subscription = event.data.object as Stripe.Subscription;
      const refs = subscriptionRefs(subscription);
      if ("kind" in refs) return refs;
      const { id: subscriptionId, customerId } = refs;
      const price = subscription.items?.data?.[0]?.price ?? null;
      const product = price?.product;
      return {
        kind: "winback_start",
        subscriptionId,
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
      // customer clicked the resubscribe button.
      const session = event.data.object as Stripe.Checkout.Session;
      const sequenceId = readWinbackSequenceId(session.metadata);
      if (!sequenceId) return { kind: "ignore", reason: "not_a_winback_checkout" };
      return { kind: "winback_reactivate", sequenceId };
    }
    case "customer.updated": {
      // Both halves are reproduced, the retrieve deferred to the processor because this function
      // makes no Stripe call (the same split customer.subscription.deleted takes for the customer
      // email).
      const customer = event.data.object as Stripe.Customer;
      if (!customer.id) return { kind: "ignore", reason: "no_customer" };
      const email = customer.email ?? "";
      if (!email) return { kind: "ignore", reason: "no_customer_email" };

      const sources = (
        customer as Stripe.Customer & {
          sources?: {
            data?: {
              object?: string;
              exp_month?: number;
              exp_year?: number;
              brand?: string;
              last4?: string;
            }[];
          };
        }
      ).sources?.data;
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
    case "customer.subscription.updated": {
      // Intelligence's real-time half (subscription-change.ts): only fields
      // Stripe lists in previous_attributes count, so an unrelated update
      // records nothing.
      const subscription = event.data.object as Stripe.Subscription;
      const refs = subscriptionRefs(subscription);
      if ("kind" in refs) return refs;
      const { id: subscriptionId, customerId } = refs;
      const changes = detectSubscriptionChanges(
        subscription,
        event.data.previous_attributes as Record<string, unknown> | undefined,
      );
      if (changes.length === 0) return { kind: "ignore", reason: "no_tracked_subscription_change" };
      return {
        kind: "record_subscription_change",
        customerId,
        subscriptionId,
        currency: subscription.currency ?? null,
        occurredAt: stripeDate(event.created),
        changes,
      };
    }
    case "payment_method.automatically_updated":
      return cardAutoUpdated(event.data.object as Stripe.PaymentMethod);
    case "invoice.marked_uncollectible": {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.id) return { kind: "ignore", reason: "no_invoice_id" };
      return { kind: "stripe_gave_up", invoiceId: invoice.id };
    }
    case "invoice.voided": {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.id) return { kind: "ignore", reason: "no_invoice_id" };
      return { kind: "invoice_voided", invoiceId: invoice.id };
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      // Only the connected account's own object, which is what Connect sends
      // this event for.
      if (!account.id || account.id !== event.account)
        return { kind: "ignore", reason: "not_this_account" };
      return {
        kind: "account_health",
        health: readAccountHealth(account),
        observedAt: stripeDate(event.created),
      };
    }
    case "account.application.deauthorized":
      return { kind: "connection_deauthorized" };
    case "radar.early_fraud_warning.created":
    case "radar.early_fraud_warning.updated": {
      const warning = event.data.object as Stripe.Radar.EarlyFraudWarning;
      const chargeId = asId(warning.charge);
      if (!warning.id || !chargeId) return { kind: "ignore", reason: "no_warning_charge" };
      return {
        kind: "early_fraud_warning",
        created: event.type === "radar.early_fraud_warning.created",
        stripeWarningId: warning.id,
        chargeId,
        paymentIntentId: asId(warning.payment_intent),
        fraudType: warning.fraud_type ?? "unknown",
        actionable: warning.actionable === true,
        createdAt: stripeDate(warning.created ?? 0),
      };
    }
    case "invoice.upcoming": {
      // A renewal Stripe will charge. An upcoming invoice has no id, and one
      // the customer pays by hand, or one for nothing, charges no card.
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = asId(invoice.customer);
      if (!customerId) return { kind: "ignore", reason: "no_customer" };
      if (invoice.collection_method !== "charge_automatically") {
        return { kind: "ignore", reason: "not_charged_automatically" };
      }
      if ((invoice.amount_due ?? 0) === 0) return { kind: "ignore", reason: "zero_amount" };
      const chargeAtSeconds =
        invoice.next_payment_attempt ?? invoice.automatically_finalizes_at ?? null;
      if (!chargeAtSeconds) return { kind: "ignore", reason: "no_charge_date" };
      return {
        kind: "renewal_card_check",
        source: "invoice_upcoming",
        customerId,
        customerEmail: invoice.customer_email ?? null,
        customerName: invoice.customer_name ?? null,
        chargeAt: stripeDate(chargeAtSeconds),
        invoiceDefault: asId(invoice.default_payment_method),
        subscription: asId(invoice.parent?.subscription_details?.subscription),
      };
    }
    case "customer.subscription.trial_will_end": {
      // Sent three days before a trial converts. A subscription set to cancel
      // at the trial's end, or invoiced by hand, will charge no card.
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = asId(subscription.customer);
      if (!customerId) return { kind: "ignore", reason: "no_customer" };
      if (!subscription.trial_end) return { kind: "ignore", reason: "no_trial_end" };
      if (
        subscription.cancel_at_period_end ||
        subscription.collection_method !== "charge_automatically"
      ) {
        return { kind: "ignore", reason: "no_charge_at_trial_end" };
      }
      return {
        kind: "renewal_card_check",
        source: "trial_will_end",
        customerId,
        customerEmail: null,
        customerName: null,
        chargeAt: stripeDate(subscription.trial_end),
        invoiceDefault: null,
        subscription: { default_payment_method: asId(subscription.default_payment_method) },
      };
    }
    default:
      return { kind: "ignore", reason: "unhandled_type" };
  }
}
