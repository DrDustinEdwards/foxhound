import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { accountMembers, accounts, getDb, stripeConnections, user } from "~/db";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { getStripe } from "~/lib/stripe/client";

import { stripeErrorSummary } from "./stripe-invoice";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// Billing-setup. The merchant is a Customer on FOXHOUND'S OWN Stripe account,
// never charged through their connected account.

/**
 * The accounts.platform_stripe_customer_id write. Mirrors the
 * stripe_connections precedent: a Stripe-account-linking write rides the
 * per-account money-write DO alongside every other billing write, even though
 * it is not itself a fee.
 */
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

/** The slice of a connected Stripe account the billing email reads. */
interface BillingEmailAccountFields {
  business_profile?: { support_email?: string | null } | null;
  email?: string | null;
}

export function resolveBillingEmailFromStripeAccount(
  stripeAccount: BillingEmailAccountFields | null,
  loginEmail: string | null,
): string | null {
  return (
    stripeAccount?.business_profile?.support_email || stripeAccount?.email || loginEmail || null
  );
}

export interface BillingEmailDeps {
  retrieveAccount: (stripeUserId: string) => Promise<BillingEmailAccountFields>;
}

/**
 * Resolve one account's billing email from what Foxhound holds. Here it is
 * resolved when the platform customer is made or needs an address: the primary
 * live connection is read through the platform key, and the login email is the
 * account owner's, who is the user who connected.
 */
export async function lookupPlatformBillingEmail(
  env: Env,
  accountId: string,
  deps?: Partial<BillingEmailDeps>,
): Promise<string | null> {
  const db = getDb(env);
  const [connection] = await db
    .select({ stripeUserId: stripeConnections.stripeUserId })
    .from(stripeConnections)
    .where(
      and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)),
    )
    .orderBy(desc(stripeConnections.isPrimary), asc(stripeConnections.createdAt))
    .limit(1);
  const [owner] = await db
    .select({ email: user.email })
    .from(accountMembers)
    .innerJoin(user, eq(user.id, accountMembers.userId))
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.role, MEMBER_ROLE.OWNER),
        eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
      ),
    )
    .orderBy(asc(accountMembers.createdAt))
    .limit(1);

  let stripeAccount: BillingEmailAccountFields | null = null;
  if (connection) {
    const retrieveAccount =
      deps?.retrieveAccount ?? ((id: string) => getStripe(env).accounts.retrieve(id));
    try {
      stripeAccount = await retrieveAccount(connection.stripeUserId);
    } catch (err) {
      console.error("billing email account read failed:", stripeErrorSummary(err));
    }
  }
  return resolveBillingEmailFromStripeAccount(stripeAccount, owner?.email ?? null);
}

/**
 * Stripe idempotency key for creating one account's platform customer. The
 * billing setup action and the billing run both create through
 * ensurePlatformCustomer, so a same-day race between them yields one customer.
 */
function platformCustomerCreateIdempotencyKey(accountId: string): string {
  return `platform-customer-create:${accountId}`;
}

export interface EnsurePlatformCustomerDeps {
  lookupBillingEmail: (env: Env, accountId: string) => Promise<string | null>;
}

/**
 * Returns the existing platform customer id, or creates one on Foxhound's own
 * Stripe account. Does not persist; the caller stores the id via
 * buildPlatformCustomerUpdate so the Stripe call and the DB write stay separate
 * concerns (mirrors createPlatformInvoice / buildInvoiceStripeRefUpdate).
 */
export async function ensurePlatformCustomer(
  env: Env,
  input: { existingCustomerId: string | null; accountId: string; accountName: string | null },
  deps?: Partial<EnsurePlatformCustomerDeps>,
): Promise<string> {
  if (input.existingCustomerId) return input.existingCustomerId;
  const lookupBillingEmail = deps?.lookupBillingEmail ?? lookupPlatformBillingEmail;
  const email = await lookupBillingEmail(env, input.accountId);
  const stripe = getStripe(env);
  let customer: Stripe.Customer;
  try {
    customer = await stripe.customers.create(
      {
        email: email ?? undefined,
        name: input.accountName || email || undefined,
        metadata: { account_id: input.accountId },
      },
      { idempotencyKey: platformCustomerCreateIdempotencyKey(input.accountId) },
    );
  } catch (err) {
    // Type and code only: Stripe's message can repeat the email it was sent.
    throw new Error(`platform customer create failed: ${stripeErrorSummary(err)}`);
  }
  return customer.id;
}

export async function syncPlatformCustomerEmail(
  env: Env,
  input: { customerId: string; email: string },
): Promise<void> {
  try {
    await getStripe(env).customers.update(input.customerId, { email: input.email });
  } catch (err) {
    console.error("platform customer email sync failed:", stripeErrorSummary(err));
  }
}

export interface BillingSetupSession {
  url: string;
}

/**
 * A Stripe-hosted Checkout Session in `setup` mode: collects a payment method
 * for the given customer without us ever touching card data. Platform billing
 * and the connected-account card update both create theirs here.
 */
export async function createSetupCheckoutSession(
  stripe: Stripe,
  input: {
    customerId: string;
    currency: string;
    clientReferenceId?: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ url: string }> {
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: input.customerId,
    client_reference_id: input.clientReferenceId,
    // Endive removed payment_method_types from Checkout. A setup session now
    // takes a currency instead, and allowed_payment_method_types keeps it to
    // cards.
    currency: input.currency,
    allowed_payment_method_types: ["card"],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  if (!session.url) {
    throw new Error("stripe checkout session create returned no url");
  }
  return { url: session.url };
}

/**
 * A setup Checkout Session for the given platform customer. Foxhound's pricing
 * is in USD; a saved card is charged in any invoice currency later.
 */
export function createBillingSetupSession(
  env: Env,
  input: { customerId: string; successUrl: string; cancelUrl: string },
): Promise<BillingSetupSession> {
  return createSetupCheckoutSession(getStripe(env), { ...input, currency: "usd" });
}

export interface FinalizeSetupResult {
  ok: boolean;
  error?: string;
}

/**
 * Extract the customer id from a Checkout Session's `customer` field, whether
 * it is an id string, an expanded object, or null. Pure.
 */
export function sessionCustomerId(
  customer: string | { id: string } | null | undefined,
): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * SECURITY: the return-leg `session_id` is an unauthenticated URL query param.
 * The retrieved session's customer MUST equal the calling account's OWN stored
 * platform customer id before we touch it, or a logged-in merchant A who
 * obtains merchant B's completed session_id could drive stripe.customers.update
 * against B's customer.
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

/**
 * Injectable IO for finalizeBillingSetupSession, so the ownership gate can be
 * exercised without a live Stripe call. Defaults are the real Stripe client.
 */
export interface FinalizeSetupDeps {
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
  setDefaultPaymentMethod: (customerId: string, paymentMethodId: string) => Promise<void>;
}

/**
 * Called on the success_url return: retrieves the completed setup session,
 * verifies it belongs to THIS account (assertSessionBelongsToAccount), then
 * sets the collected payment method as the customer's default so the monthly
 * billing run's `charge_automatically` invoices have one to use. The ownership
 * gate runs BEFORE any customer mutation, so a foreign session never writes.
 */
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

  const paymentMethodId = setupSessionPaymentMethod(session);
  if (!paymentMethodId) {
    return { ok: false, error: "no payment method attached to setup intent" };
  }
  await setDefaultPaymentMethod(owned.customerId, paymentMethodId);
  return { ok: true };
}

/**
 * The card a completed setup session collected, from its expanded setup_intent;
 * null when there is none. Pure.
 */
export function setupSessionPaymentMethod(session: Stripe.Checkout.Session): string | null {
  const setupIntent = session.setup_intent;
  if (typeof setupIntent !== "object" || setupIntent === null) return null;
  const pm = setupIntent.payment_method;
  return typeof pm === "string" ? pm : (pm?.id ?? null);
}

export interface CardSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/**
 * The slice of a retrieved customer this read uses. Structural, so a test can
 * inject a plain object without building a whole Stripe.Customer.
 */
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
 * customer, a default that is not a card, and a read that fails.
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
    console.error("billing card read failed:", errorMessage(err));
    return null;
  }
}
