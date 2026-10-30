import type Stripe from "stripe";

import {
  disputeFundsMovements,
  disputeIntakeFields,
  disputeLiveFields,
  type DisputeFundsMovement,
  type DisputeLiveFields,
} from "~/lib/disputes/stripe-dispute";

import { type DeclineCategory } from "~/lib/constants";
import { detectSubscriptionChanges, type SubscriptionChange } from "~/lib/intelligence/subscription-change";
import { readWinbackSequenceId } from "~/lib/recovery/winback-metadata";
import { classifyDecline } from "~/lib/recovery/decline";
import { readAccountHealth, type AccountHealth } from "~/lib/stripe/account-health";
import { asId } from "~/lib/stripe/ids";

// Pure Stripe-event classification for the connected-account webhook. Maps a
// verified event to the intent the processor acts on and pulls the refs it needs
// off the event object, with NO extra Stripe calls (enrichment reads that need
// live Stripe are the processor's deferred seam). Everything here is unit-tested.
//
// Events we act on (legacy parity, trimmed to the money-critical set for 4c):
//   invoice.payment_failed     -> intake (create failed_payment + recovery steps)
//   invoice.payment_succeeded  -> recover (owns the 'recovered' status flip)
//   invoice.marked_uncollectible -> stripe_gave_up (starts a parked sequence)
//   invoice.voided             -> invoice_voided (stops recovery: nothing to collect)
//   charge.refunded            -> stamp_refund (unbills the recovery, any refund)
//   charge.dispute.created     -> stamp_dispute (dispute intake; feeds the billable predicate)
//   charge.dispute.closed      -> dispute_resolved (5c: won/lost state + fee snapshot),
//                                 or inquiry_closed for an inquiry closed as warning_closed
//   charge.dispute.updated     -> dispute_updated (live status, deadline, evidence counts)
//   charge.dispute.funds_withdrawn / funds_reinstated -> dispute_funds (money Stripe moved)
//   account.updated            -> account_health (the connected account's own
//                                 charges, payouts and requirements)
//   account.application.deauthorized -> connection_deauthorized (the merchant
//                                 revoked Foxhound's grant at Stripe)
//   radar.early_fraud_warning.created/.updated -> early_fraud_warning (record + notice)
//   payment_method.automatically_updated -> card_auto_updated (retry on the new card)
//   payment_method.card_automatically_updated (its pre-2020 name) -> card_auto_updated
// Everything else is ignored.

export type WebhookIntent =
  | {
      kind: "intake";
      invoiceId: string;
      customerId: string;
      /** The invoice's subscription, so the card-update page can move the
       *  subscription itself onto the new card (a subscription's own default
       *  card outranks the customer's). */
      subscriptionId: string | null;
      customerEmail: string;
      customerName: string | null;
      amountCents: number;
      currency: string;
      declineCode: string | null;
      declineCategory: DeclineCategory;
      /**
       * TRUE when Stripe has stopped retrying this invoice, read from
       * `next_payment_attempt` being null (ruling 377(1)). This is the whole
       * gate: while Stripe has another attempt scheduled the payment is
       * Stripe's, and Foxhound plans nothing.
       *
       * Hard declines (expired, fraud, revoked) are the exception, decided in
       * handleIntake once the charge's real decline code is read: Stripe keeps
       * a next_payment_attempt on those invoices but runs it only after a new
       * payment method is attached (docs.stripe.com/billing/revenue-recovery/
       * smart-retries), so their email-led sequence starts on the first
       * failure. Foxhound's own retries still wait for Stripe to stop
       * (engine/retry-step.ts reads next_payment_attempt before charging).
       */
      stripeGaveUp: boolean;
    }
  | {
      /** invoice.marked_uncollectible: Stripe has written the invoice off, so
       *  it is unambiguously finished with it. Promotes a stripe_retrying row
       *  the same way a final payment_failed does (377(1)). */
      kind: "stripe_gave_up";
      invoiceId: string;
    }
  | {
      /** invoice.voided: the invoice is canceled and can never be paid, so a
       *  live recovery for it stops. */
      kind: "invoice_voided";
      invoiceId: string;
    }
  | {
      kind: "recover";
      invoiceId: string;
      customerId: string | null;
      /** The invoice's subscription, when it has one. A win-back reactivation
       *  is read off THIS subscription's metadata (344 binding 1). */
      subscriptionId: string | null;
      /** When the customer actually paid (Stripe's paid_at), not when the
       *  event reached Foxhound: attribution compares signals against it, so
       *  a late or replayed event cannot credit Foxhound with a payment the
       *  customer made before the click or card update. Null when the event
       *  carries neither paid_at nor its own created time. */
      paidAt: Date | null;
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
  | { kind: "inquiry_closed"; stripeDisputeId: string }
  | ({
      kind: "dispute_updated";
      /** The event's own `created`, so a late older update never wins. */
      eventCreatedAt: Date;
      funds: DisputeFundsMovement[];
    } & DisputeLiveFields)
  | { kind: "dispute_funds"; stripeDisputeId: string; funds: DisputeFundsMovement[] }
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
  | {
      /** customer.subscription.updated that scheduled or took back a
       *  cancellation, paused or resumed collection, or lowered the monthly
       *  amount: recorded for Intelligence the moment Stripe sends it. */
      kind: "record_subscription_change";
      customerId: string;
      subscriptionId: string;
      currency: string | null;
      occurredAt: Date;
      changes: SubscriptionChange[];
    }
  | {
      /** account.updated for the connected account itself. `observedAt` is the
       *  event's created time, so a late older event cannot overwrite newer state. */
      kind: "account_health";
      health: AccountHealth;
      observedAt: Date;
    }
  | {
      /** radar.early_fraud_warning.created or .updated. The charge's amount,
       *  currency and customer are read by the handler, per this file's rule
       *  that the classifier makes no Stripe call. */
      kind: "early_fraud_warning";
      created: boolean;
      stripeWarningId: string;
      chargeId: string;
      paymentIntentId: string | null;
      fraudType: string;
      actionable: boolean;
      createdAt: Date;
    }
  | {
      /** invoice.upcoming or customer.subscription.trial_will_end: a charge is
       *  coming at `chargeAt`, so the card it will use is checked now. Records
       *  through the expiring-card table and never sends. */
      kind: "renewal_card_check";
      source: "invoice_upcoming" | "trial_will_end";
      customerId: string;
      /** From the event when it carries them; otherwise read off the customer. */
      customerEmail: string | null;
      customerName: string | null;
      chargeAt: Date;
      /** The charge's payment method sources, as card-change.ts resolves them:
       *  the invoice's own default (invoice.upcoming only), then the
       *  subscription (its id, or the event's own subscription object). */
      invoiceDefault: string | null;
      subscription: string | { default_payment_method: string | null } | null;
    }
  | {
      /** payment_method.automatically_updated: the customer's card was
       *  refreshed by Stripe's card updater, so an active failed payment is
       *  retried on it now. */
      kind: "card_auto_updated";
      customerId: string;
    }
  | {
      /** account.application.deauthorized: the merchant revoked the grant from
       *  their Stripe dashboard, so the live connection is marked disconnected.
       *  The grant is already gone at Stripe; nothing calls deauthorize again. */
      kind: "connection_deauthorized";
    }
  | { kind: "ignore"; reason: string };

/** Classify a verified Stripe event into the processor intent. Pure. */
/** Stripe's card updater replaced the card details (a new expiry or number
 *  from the network). Whether the customer has a payment to retry is the
 *  processor's question. */
function cardAutoUpdated(paymentMethod: Stripe.PaymentMethod): WebhookIntent {
  const customerId = asId(paymentMethod.customer);
  if (!customerId) return { kind: "ignore", reason: "no_customer" };
  return { kind: "card_auto_updated", customerId };
}

function unixToDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

export function classifyStripeEvent(event: Stripe.Event): WebhookIntent {
  // Stripe's name for payment_method.automatically_updated before 2020-08-27,
  // with the same PaymentMethod payload. Stripe no longer emits it and the SDK
  // no longer types it (see readCardUpdaterEvents), but the endive Connect
  // destination still lists it, so one that arrives takes the same path.
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
      // $0 invoices are not recoverable revenue; skip (legacy parity).
      if ((invoice.amount_due ?? 0) === 0) return { kind: "ignore", reason: "zero_amount" };
      // Only what the event carries, which on the pinned API version is a
      // finalization failure at most (the invoice has no `charge`). The real
      // payment decline is read off the latest charge in handleIntake, and
      // this code is its fallback.
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
        paidAt: unixToDate(invoice.status_transitions?.paid_at ?? event.created),
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
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      // The mapping moved to app/lib/disputes/stripe-dispute.ts under ruling
      // 400, because the manual import reads a Stripe.Dispute too and the two
      // intake paths have to produce the same row from the same object. A null
      // here is the charge-less case this branch already ignored.
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
      if (dispute.status === "warning_closed") return { kind: "inquiry_closed", stripeDisputeId: dispute.id };
      if (dispute.status !== "won" && dispute.status !== "lost") {
        return { kind: "ignore", reason: "dispute_not_resolved" };
      }
      return { kind: "dispute_resolved", stripeDisputeId: dispute.id, won: dispute.status === "won" };
    }
    case "charge.dispute.updated": {
      const fields = disputeLiveFields(event.data.object as Stripe.Dispute);
      if (!fields) return { kind: "ignore", reason: "no_dispute_id" };
      return {
        kind: "dispute_updated",
        ...fields,
        eventCreatedAt: new Date(event.created * 1000),
        funds: disputeFundsMovements(event.data.object as Stripe.Dispute),
      };
    }
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute.id) return { kind: "ignore", reason: "no_dispute_id" };
      return { kind: "dispute_funds", stripeDisputeId: dispute.id, funds: disputeFundsMovements(dispute) };
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
    case "customer.subscription.updated": {
      // Intelligence's real-time half (subscription-change.ts): only fields
      // Stripe lists in previous_attributes count, so an unrelated update
      // records nothing.
      const subscription = event.data.object as Stripe.Subscription;
      if (!subscription.id) return { kind: "ignore", reason: "no_subscription_id" };
      const customerId = asId(subscription.customer);
      if (!customerId) return { kind: "ignore", reason: "no_customer" };
      const changes = detectSubscriptionChanges(
        subscription,
        event.data.previous_attributes as Record<string, unknown> | undefined,
      );
      if (changes.length === 0) return { kind: "ignore", reason: "no_tracked_subscription_change" };
      return {
        kind: "record_subscription_change",
        customerId,
        subscriptionId: subscription.id,
        currency: subscription.currency ?? null,
        occurredAt: new Date(event.created * 1000),
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
      if (!account.id || account.id !== event.account) return { kind: "ignore", reason: "not_this_account" };
      return { kind: "account_health", health: readAccountHealth(account), observedAt: new Date(event.created * 1000) };
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
        createdAt: new Date((warning.created ?? 0) * 1000),
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
      const chargeAtSeconds = invoice.next_payment_attempt ?? invoice.automatically_finalizes_at ?? null;
      if (!chargeAtSeconds) return { kind: "ignore", reason: "no_charge_date" };
      return {
        kind: "renewal_card_check",
        source: "invoice_upcoming",
        customerId,
        customerEmail: invoice.customer_email ?? null,
        customerName: invoice.customer_name ?? null,
        chargeAt: new Date(chargeAtSeconds * 1000),
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
      if (subscription.cancel_at_period_end || subscription.collection_method !== "charge_automatically") {
        return { kind: "ignore", reason: "no_charge_at_trial_end" };
      }
      return {
        kind: "renewal_card_check",
        source: "trial_will_end",
        customerId,
        customerEmail: null,
        customerName: null,
        chargeAt: new Date(subscription.trial_end * 1000),
        invoiceDefault: null,
        subscription: { default_payment_method: asId(subscription.default_payment_method) },
      };
    }
    default:
      return { kind: "ignore", reason: "unhandled_type" };
  }
}
