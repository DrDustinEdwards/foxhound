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

/** A Stripe-hosted Checkout Session in `setup` mode on the connected account:
 *  collects a payment method for the given customer without us ever touching
 *  card data or the merchant's Stripe secret key. */
export async function createCardUpdateSession(input: {
  accessToken: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<CardUpdateSession> {
  const stripe = getConnectedStripe(input.accessToken);
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: input.customerId,
    payment_method_types: ["card"],
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
  if (input.subscriptionId) {
    await stripe.subscriptions.update(input.subscriptionId, {
      default_payment_method: paymentMethodId,
    });
  }
  return { ok: true };
}
