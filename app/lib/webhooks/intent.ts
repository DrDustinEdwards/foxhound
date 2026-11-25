import type { DeclineCategory } from "~/lib/constants";
import type { DisputeFundsMovement, DisputeLiveFields } from "~/lib/disputes/stripe-dispute";
import type { SubscriptionChange } from "~/lib/intelligence/subscription-change";
import type { AccountHealth } from "~/lib/stripe/account-health";

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
       * TRUE when Stripe has stopped retrying this invoice, read from `next_payment_attempt` being
       * null. Hard declines (expired, fraud, revoked) are the exception, decided in handleIntake
       * once the charge's real decline code is read: Stripe keeps a next_payment_attempt on those
       * invoices but runs it only after a new payment method is attached
       * (docs.stripe.com/billing/revenue-recovery/ smart-retries), so their email-led sequence
       * starts on the first failure.
       */
      stripeGaveUp: boolean;
    }
  | {
      /** invoice.marked_uncollectible: Stripe has written the invoice off, so
       *  it is unambiguously finished with it. Promotes a stripe_retrying row
       *  the same way a final payment_failed does. */
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
       *  is read off THIS subscription's metadata. */
      subscriptionId: string | null;
      /**
       * When the customer actually paid (Stripe's paid_at), not when the event reached Foxhound:
       * attribution compares signals against it, so a late or replayed event cannot credit Foxhound
       * with a payment the customer made before the click or card update.
       */
      paidAt: Date | null;
      amountPaidCents: number;
      currency: string;
    }
  | {
      /** A Checkout Session completed carrying a win-back sequence id, which is
       *  the EXACT reactivation signal: the session Foxhound created on the
       *  resubscribe click carries the id in its own metadata. */
      kind: "winback_reactivate";
      sequenceId: string;
    }
  | {
      kind: "stamp_refund";
      paymentIntentId: string;
      /** charge.amount_refunded: cumulative, so a late event never undoes a later one. */
      refundedCents: number;
      /** charge.refunded: the whole charge is refunded, so no fee at all. */
      full: boolean;
    }
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
      /** customer.updated carrying a card inside the expiring-card lead window. */
      kind: "record_expiring_card";
      customerId: string;
      customerEmail: string;
      customerName: string | null;
      /** The card, when the event already carries it. */
      card: {
        expMonth: number;
        expYear: number;
        brand: string | null;
        last4: string | null;
      } | null;
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
