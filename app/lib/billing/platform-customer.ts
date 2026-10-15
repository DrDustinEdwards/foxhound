import { eq } from "drizzle-orm";
import type Stripe from "stripe";

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

/** Extract the customer id from a Checkout Session's `customer` field, whether
 *  it is an id string, an expanded object, or null. Pure. */
export function sessionCustomerId(
  customer: string | { id: string } | null | undefined,
): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * SECURITY (account-scoping audit HIGH #2): the return-leg `session_id` is an
 * unauthenticated URL query param. The retrieved session's customer MUST equal
 * the calling account's OWN stored platform customer id before we touch it, or
 * a logged-in merchant A who obtains merchant B's completed session_id could
 * drive stripe.customers.update against B's customer. `expectedCustomerId` is
 * accounts.platform_stripe_customer_id for the SESSION's own account, persisted
 * before the redirect out (billing/index.tsx action), so on the return leg it
 * is present and account-bound. A null expected id (account never set up) or a
 * mismatch both reject. Pure, so the ownership decision is directly unit-tested.
 */
export function assertSessionBelongsToAccount(
  session: { customer: string | { id: string } | null | undefined },
  expectedCustomerId: string | null,
): { ok: true; customerId: string } | { ok: false; error: string } {
  const customerId = sessionCustomerId(session.customer);
  if (!expectedCustomerId || !customerId || customerId !== expectedCustomerId) {
    return { ok: false, error: "setup session does not belong to this account" };
  }
  return { ok: true, customerId };
}

/** Injectable IO for finalizeBillingSetupSession, so the ownership gate can be
 *  exercised without a live Stripe call. Defaults are the real Stripe client. */
export interface FinalizeSetupDeps {
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
  setDefaultPaymentMethod: (customerId: string, paymentMethodId: string) => Promise<void>;
}

/** Called on the success_url return: retrieves the completed setup session,
 *  verifies it belongs to THIS account (assertSessionBelongsToAccount), then
 *  sets the collected payment method as the customer's default so the monthly
 *  billing run's `charge_automatically` invoices have one to use. The ownership
 *  gate runs BEFORE any customer mutation, so a foreign session never writes. */
export async function finalizeBillingSetupSession(
  env: Env,
  input: { sessionId: string; expectedCustomerId: string | null },
  deps?: Partial<FinalizeSetupDeps>,
): Promise<FinalizeSetupResult> {
  // Lazily construct the Stripe client only if a default dep is actually used,
  // so fully-injected callers (tests) never require STRIPE_SECRET_KEY.
  let stripeClient: Stripe | null = null;
  const stripe = () => (stripeClient ??= getStripe(env));
  const retrieveSession =
    deps?.retrieveSession ??
    ((id: string) => stripe().checkout.sessions.retrieve(id, { expand: ["setup_intent"] }));
  const setDefaultPaymentMethod =
    deps?.setDefaultPaymentMethod ??
    (async (customerId: string, paymentMethodId: string) => {
      await stripe().customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    });

  const session = await retrieveSession(input.sessionId);
  if (session.status !== "complete" || !session.customer) {
    return { ok: false, error: "setup session not complete" };
  }
  // Ownership gate FIRST: never mutate a customer the caller does not own.
  const owned = assertSessionBelongsToAccount(session, input.expectedCustomerId);
  if (!owned.ok) return owned;

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
  await setDefaultPaymentMethod(owned.customerId, paymentMethodId);
  return { ok: true };
}

/** The platform customer's default card, as Recova's Payment method section
 *  shows it (J65, row S3): brand, last four, expiry. */
export interface CardSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** The slice of a retrieved customer this read uses. Structural, so a test can
 *  inject a plain object without building a whole Stripe.Customer. */
interface CustomerWithDefaultCard {
  deleted?: boolean;
  invoice_settings?: {
    default_payment_method?:
      | string
      | { card?: { brand: string; last4: string; exp_month: number; exp_year: number } | null }
      | null;
  } | null;
}

export interface DefaultCardDeps {
  retrieveCustomer: (customerId: string) => Promise<CustomerWithDefaultCard>;
}

/**
 * The card on file for /billing, or null. READ ONLY: it retrieves the platform
 * customer with its default payment method expanded and writes nothing.
 *
 * Null covers every case the page renders as "No payment method on file": a
 * customer the setup action created but whose card was never collected (the
 * action stores the customer id before redirecting to Stripe), a deleted
 * customer, a default that is not a card, and a read that fails. A failed read
 * is logged and shown as no card rather than breaking the billing page, as
 * Recova's fetchPaymentMethod does.
 */
export async function getDefaultCard(
  env: Env,
  customerId: string,
  deps?: Partial<DefaultCardDeps>,
): Promise<CardSummary | null> {
  const retrieveCustomer =
    deps?.retrieveCustomer ??
    ((id: string) =>
      getStripe(env).customers.retrieve(id, {
        expand: ["invoice_settings.default_payment_method"],
      }) as Promise<CustomerWithDefaultCard>);
  try {
    const customer = await retrieveCustomer(customerId);
    if (customer.deleted) return null;
    const pm = customer.invoice_settings?.default_payment_method;
    if (!pm || typeof pm === "string" || !pm.card) return null;
    return {
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    };
  } catch (err) {
    console.error("billing card read failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
