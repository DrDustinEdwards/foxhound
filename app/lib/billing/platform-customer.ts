import { eq } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts } from "~/db";
import { getStripe } from "~/lib/stripe/client";

// Billing-setup (Phase 5 slice 5d, PRICING.md rev 3: direct platform invoicing).
// The merchant is a Customer on FOXHOUND'S OWN Stripe account, never charged
// through their connected account. This module creates that customer + collects
// a payment method via a Stripe-hosted Checkout Session in `setup` mode, the
// same "redirect out, callback in" shape already proven by the Connect OAuth
// flow (app/routes/auth/connect.tsx), so no Stripe.js/Elements integration or
// publishable key is needed on our side.
//
// LIVE redirects are exercised in Phase 8 (needs a live Stripe test-mode
// session); the seams here typecheck and are unit-proven at the pure-guard
// level (run.ts's shouldAttemptPlatformCharge).

/** The accounts.platform_stripe_customer_id write. Mirrors the stripe_connections
 *  precedent (gotcha #22): a Stripe-account-linking write rides the per-account
 *  money-write DO alongside every other billing write, even though it is not
 *  itself a fee. */
export function buildPlatformCustomerUpdate(
  db: Db,
  input: { accountId: string; platformStripeCustomerId: string },
): MoneyWriteBatch {
  return [
    db
      .update(accounts)
      .set({ platformStripeCustomerId: input.platformStripeCustomerId })
      .where(eq(accounts.id, input.accountId)),
  ];
}

/** Returns the existing platform customer id, or creates one on Foxhound's own
 *  Stripe account. Does not persist; the caller stores the id via
 *  buildPlatformCustomerUpdate so the Stripe call and the DB write stay
 *  separate concerns (mirrors createPlatformInvoice / buildInvoiceStripeRefUpdate). */
export async function ensurePlatformCustomer(
  env: Env,
  input: { existingCustomerId: string | null; accountId: string; accountName: string | null },
): Promise<string> {
  if (input.existingCustomerId) return input.existingCustomerId;
  const stripe = getStripe(env);
  const customer = await stripe.customers.create({
    name: input.accountName ?? undefined,
    metadata: { account_id: input.accountId },
  });
  return customer.id;
}

export interface BillingSetupSession {
  url: string;
}

/** A Stripe-hosted Checkout Session in `setup` mode: collects a payment method
 *  for the given platform customer without us ever touching card data. */
export async function createBillingSetupSession(
  env: Env,
  input: { customerId: string; successUrl: string; cancelUrl: string },
): Promise<BillingSetupSession> {
  const stripe = getStripe(env);
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

export interface FinalizeSetupResult {
  ok: boolean;
  error?: string;
}

/** Called on the success_url return: retrieves the completed setup session,
 *  and sets the collected payment method as the customer's default so the
 *  monthly billing run's `charge_automatically` invoices have one to use. */
export async function finalizeBillingSetupSession(
  env: Env,
  sessionId: string,
): Promise<FinalizeSetupResult> {
  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
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
  return { ok: true };
}
