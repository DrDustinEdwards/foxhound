import type Stripe from "stripe";

import {
  WINBACK_SEQUENCE_METADATA_KEY,
  WINBACK_STEP_METADATA_KEY,
} from "~/lib/recovery/winback-metadata";
import {
  assertSessionBelongsToAccount,
  setupSessionPaymentMethod,
} from "~/lib/billing/platform-customer";
import { getConnectedStripe } from "~/lib/stripe/client";

// Card-update payment-method collection (Phase 5 slice 5g, PRICING.md
// card_update: "payment method updated through a Foxhound link/page"). Mirrors
// billing-setup's Stripe-hosted Checkout Session in `setup` mode
// (app/lib/billing/platform-customer.ts), but scoped to the CONNECTED account
// (the merchant's own Stripe, via the customer's decrypted OAuth access token)
// instead of Foxhound's platform account: this collects a payment method for
// the merchant's customer, not for Foxhound's own billing.

export interface CardUpdateSession {
  url: string;
}

/**
 * The customer's billing currency, for a setup session with no failed payment
 * to take one from. A customer never billed has none: usd then, which still
 * saves a card that later charges in any currency.
 */
async function customerCurrency(stripe: Stripe, customerId: string): Promise<string> {
  const customer = await stripe.customers.retrieve(customerId);
  return ("deleted" in customer && customer.deleted ? null : customer.currency) ?? "usd";
}

/**
 * A Stripe-hosted Checkout Session in `setup` mode on the connected account:
 * collects a payment method for the given customer without us ever touching
 * card data or the merchant's Stripe secret key.
 */
export async function createCardUpdateSession(input: {
  accessToken: string;
  customerId: string;
  /** The link's own row (failed payment or alert id), checked on return. */
  linkRef: string;
  /**
   * The failed payment's currency; absent in alert mode, where nothing failed.
   */
  currency?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<CardUpdateSession> {
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: input.customerId,
    client_reference_id: input.linkRef,
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

/**
 * Called on the success_url return: retrieves the completed setup session and
 * sets the collected payment method as the customer's default, and the
 * subscription's default if one is known, so the next recovery retry uses the
 * new card.
 *
 * session_id comes from the URL, so the session must be the one THIS link made:
 * setup mode, this link's reference, this link's customer.
 */
export async function finalizeCardUpdateSession(input: {
  accessToken: string;
  sessionId: string;
  /**
   * The link's customer and reference, as passed to createCardUpdateSession.
   */
  customerId: string;
  linkRef: string;
  subscriptionId?: string | null;
  /** Read for its subscription when `subscriptionId` is not known. */
  invoiceId?: string | null;
}): Promise<FinalizeCardUpdateResult> {
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.retrieve(input.sessionId, {
    expand: ["setup_intent"],
  });
  if (session.mode !== "setup" || session.client_reference_id !== input.linkRef) {
    return { ok: false, error: "setup session was not made for this link" };
  }
  const owned = assertSessionBelongsToAccount(session, input.customerId);
  if (!owned.ok) return owned;
  if (session.status !== "complete") {
    return { ok: false, error: "setup session not complete" };
  }
  const paymentMethodId = setupSessionPaymentMethod(session);
  if (!paymentMethodId) {
    return { ok: false, error: "no payment method attached to setup intent" };
  }
  await stripe.customers.update(owned.customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  // A subscription's own default card outranks the customer's, so a retry would
  // still charge the declined card unless the subscription moves too.
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

// The metadata keys the created Checkout Session and its subscription carry.
// They live in ~/lib/recovery/winback-metadata so the webhook classifier that
// READS them and this creator that WRITES them share one definition.

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

/** Read the canceled subscription's price back off Stripe. */
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

/**
 * Create the Checkout Session on the CONNECTED account. Foxhound creates no
 * subscription of its own; Stripe does, on the merchant's account, when the
 * customer completes the session.
 */
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
