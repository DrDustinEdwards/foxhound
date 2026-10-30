import type Stripe from "stripe";

import {
  WINBACK_SEQUENCE_METADATA_KEY,
  WINBACK_STEP_METADATA_KEY,
} from "~/lib/recovery/winback-metadata";
import { getConnectedStripe } from "~/lib/stripe/client";

// Card-update payment-method collection (Phase 5 slice 5g, PRICING.md
// card_update: "payment method updated through a Foxhound link/page"). Mirrors
// billing-setup's Stripe-hosted Checkout Session in `setup` mode
// (app/lib/billing/platform-customer.ts), but scoped to the CONNECTED
// account (the merchant's own Stripe, via the customer's decrypted OAuth
// access token) instead of Foxhound's platform account: this collects a
// payment method for the merchant's customer, not for Foxhound's own billing.
//
// LIVE redirects are exercised in Phase 8 (needs a live Stripe test-mode
// session); the seams here typecheck and are unit-proven at the pure level.

export interface CardUpdateSession {
  url: string;
}

/** The customer's billing currency, for a setup session with no failed
 *  payment to take one from. A customer never billed has none: usd then,
 *  which still saves a card that later charges in any currency. */
async function customerCurrency(stripe: Stripe, customerId: string): Promise<string> {
  const customer = await stripe.customers.retrieve(customerId);
  return ("deleted" in customer && customer.deleted ? null : customer.currency) ?? "usd";
}

/** A Stripe-hosted Checkout Session in `setup` mode on the connected account:
 *  collects a payment method for the given customer without us ever touching
 *  card data or the merchant's Stripe secret key. */
export async function createCardUpdateSession(input: {
  accessToken: string;
  customerId: string;
  /** The failed payment's currency; absent in alert mode, where nothing failed. */
  currency?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<CardUpdateSession> {
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: input.customerId,
    // Endive removed payment_method_types from Checkout. A setup session now
    // takes a currency instead, and allowed_payment_method_types keeps it to
    // cards, as before.
    currency: input.currency ?? (await customerCurrency(stripe, input.customerId)),
    allowed_payment_method_types: ["card"],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  if (!session.url) {
    throw new Error("stripe checkout session create returned no url");
  }
  return { url: session.url };
}

export interface FinalizeCardUpdateResult {
  ok: boolean;
  error?: string;
}

/** Called on the success_url return: retrieves the completed setup session
 *  and sets the collected payment method as the customer's default, and the
 *  subscription's default if one is known, so the next recovery retry uses
 *  the new card. */
export async function finalizeCardUpdateSession(input: {
  accessToken: string;
  sessionId: string;
  subscriptionId?: string | null;
  /** Read for its subscription when `subscriptionId` is not known. */
  invoiceId?: string | null;
}): Promise<FinalizeCardUpdateResult> {
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.retrieve(input.sessionId, {
    expand: ["setup_intent"],
  });
  if (session.status !== "complete" || !session.customer) {
    return { ok: false, error: "setup session not complete" };
  }
  const setupIntent = session.setup_intent;
  const paymentMethodId =
    typeof setupIntent === "object" && setupIntent !== null
      ? typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : (setupIntent.payment_method?.id ?? null)
      : null;
  if (!paymentMethodId) {
    return { ok: false, error: "no payment method attached to setup intent" };
  }
  const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  // A subscription's own default card outranks the customer's, so a retry
  // would still charge the declined card unless the subscription moves too.
  let subscriptionId = input.subscriptionId ?? null;
  if (!subscriptionId && input.invoiceId) {
    const invoice = await stripe.invoices.retrieve(input.invoiceId);
    const sub = invoice.parent?.subscription_details?.subscription ?? null;
    subscriptionId = typeof sub === "string" ? sub : (sub?.id ?? null);
  }
  if (subscriptionId) {
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: paymentMethodId,
    });
  }
  return { ok: true };
}

// ── Resubscribe ──────────────────────────────────────────────
// Legacy's win-back email links to a Stripe billing portal session created at
// SEND time, once per step, on the merchant's account. Foxhound creates nothing
// at send time: the email carries a signed token, and the Stripe object is
// created only when a customer actually clicks. Stripe hosts the subscription
// creation, so Foxhound never calls `subscriptions.create` and never writes a
// subscription itself.

// The metadata keys the created Checkout Session and its subscription carry.
// They live in ~/lib/recovery/winback-metadata so the webhook classifier that
// READS them and this creator that WRITES them share one definition.
;

interface ResubscribeSessionParamsInput {
  customerId: string;
  priceId: string;
  quantity: number;
  winBackSequenceId: string;
  winBackStepNumber: number;
  successUrl: string;
  cancelUrl: string;
}

/**
 * The Checkout Session arguments, assembled pure so a plant can read exactly
 * what goes to Stripe (337 binding 4: a test that rebuilds the input by hand
 * proves the test, not the code).
 *
 * The metadata pair is set TWICE on purpose. `checkout.session.completed`
 * carries `session.metadata`, but `invoice.payment_succeeded`, the event legacy
 * actually keys its reactivation on, carries only the invoice, whose
 * subscription carries `subscription_data.metadata`. Setting both leaves
 * session 52 an exact match on either event.
 */
function buildResubscribeSessionParams(input: ResubscribeSessionParamsInput) {
  const metadata = {
    [WINBACK_SEQUENCE_METADATA_KEY]: input.winBackSequenceId,
    [WINBACK_STEP_METADATA_KEY]: String(input.winBackStepNumber),
  };
  return {
    mode: "subscription" as const,
    customer: input.customerId,
    line_items: [{ price: input.priceId, quantity: input.quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata,
    subscription_data: { metadata },
  };
}

interface ResubscribePlan {
  priceId: string;
  quantity: number;
}

/**
 * Read the canceled subscription's price back off Stripe.
 *
 * `win_back_sequences` stores `plan_name`, `amount_cents` and `currency` and NO
 * price id, on both sides, because legacy's billing portal needed none. A
 * Checkout Session does, and a canceled subscription is still retrievable, so
 * the price is re-read at click rather than stored. This is a READ: it creates
 * and modifies nothing.
 */
async function loadResubscribePlan(input: {
  accessToken: string;
  subscriptionId: string;
}): Promise<ResubscribePlan | null> {
  const stripe = getConnectedStripe(input.accessToken);
  const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
  const item = subscription.items?.data?.[0];
  const priceId = typeof item?.price === "object" ? item.price?.id : undefined;
  if (!priceId) return null;
  return { priceId, quantity: item?.quantity ?? 1 };
}

/** Create the Checkout Session on the CONNECTED account. Foxhound creates no
 *  subscription of its own; Stripe does, on the merchant's account, when the
 *  customer completes the session. */
export async function createResubscribeSession(input: {
  accessToken: string;
  customerId: string;
  subscriptionId: string;
  winBackSequenceId: string;
  winBackStepNumber: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<CardUpdateSession | null> {
  const plan = await loadResubscribePlan({
    accessToken: input.accessToken,
    subscriptionId: input.subscriptionId,
  });
  if (!plan) return null;
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.create(
    buildResubscribeSessionParams({
      customerId: input.customerId,
      priceId: plan.priceId,
      quantity: plan.quantity,
      winBackSequenceId: input.winBackSequenceId,
      winBackStepNumber: input.winBackStepNumber,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    }),
  );
  if (!session.url) {
    throw new Error("stripe checkout session create returned no url");
  }
  return { url: session.url };
}
