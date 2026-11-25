import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, stripeConnections } from "~/db";
import { pickDeclineCode } from "~/lib/recovery/decline";
import type { RecoveredChargeFee } from "~/lib/recovery/record-recovery";
import { getConnectedStripe } from "~/lib/stripe/client";
import { latestInvoiceCharge } from "~/lib/stripe/invoice-charge";
import { decryptToken } from "~/lib/stripe/encryption";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// The Stripe-side reads of the connected-account webhook processor: the
// connected account's customer, card and charge facts. Each is best effort
// unless its own comment says it throws.

/** The connected-account customer, for the email a win-back sequence needs. */
export async function resolveConnectedCustomer(
  env: Env,
  connectionId: string,
  stripeCustomerId: string,
): Promise<{ email: string | null; name: string | null } | null> {
  try {
    const stripe = await connectedStripeFor(env, connectionId);
    if (!stripe) return null;
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.deleted) return null;
    return { email: customer.email ?? null, name: customer.name ?? null };
  } catch {
    return null;
  }
}

/**
 * The card behind a customer.updated, retrieving the payment method only when the event did not
 * already carry one. Returns null when there is no card to read, which the caller treats as a
 * claim-only ignore rather than an error: a customer update that touches no card is an ordinary
 * event, not a failure.
 */
export async function resolveExpiringCard(
  env: Env,
  connectionId: string,
  intent: {
    card: { expMonth: number; expYear: number; brand: string | null; last4: string | null } | null;
    paymentMethodId: string | null;
  },
): Promise<{
  expMonth: number;
  expYear: number;
  brand: string | null;
  last4: string | null;
} | null> {
  if (intent.card) return intent.card;
  if (!intent.paymentMethodId) return null;
  try {
    const stripe = await connectedStripeFor(env, connectionId);
    if (!stripe) return null;
    const pm = await stripe.paymentMethods.retrieve(intent.paymentMethodId);
    if (!pm.card?.exp_month || !pm.card?.exp_year) return null;
    return {
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      brand: pm.card.brand ?? null,
      last4: pm.card.last4 ?? null,
    };
  } catch (err) {
    // A Stripe failure here loses one candidate; the nightly scan finds the
    // same card again. Never fail the webhook for it.
    console.error("expiring-card payment method lookup failed:", errorMessage(err));
    return null;
  }
}

/** The connected account's Stripe client, or null when the connection has no
 *  token. Decrypt and lookup errors propagate to the caller's catch. */
export async function connectedStripeFor(env: Env, connectionId: string) {
  const [connection] = await getDb(env)
    .select({ accessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId))
    .limit(1);
  if (!connection?.accessToken) return null;
  return getConnectedStripe(await decryptToken(env, connection.accessToken));
}

/** What the declined charge says about a failure, beyond what the invoice event
 *  carries. Every field is nullable: Stripe fills them per network and card. */
export interface DeclineFacts {
  declineCode: string | null;
  networkAdviceCode: string | null;
  networkDeclineCode: string | null;
  cardFunding: string | null;
  cardBrand: string | null;
  cardCountry: string | null;
}

/** What intake reads from Stripe about a failure: the declined charge's facts
 *  and the invoice's status now. Either is null when it could not be read. */
export interface FailureFacts {
  decline: DeclineFacts | null;
  /** The invoice's current status ("open", "paid", "void" and so on). A late
   *  or redelivered payment_failed can arrive after the invoice was paid or
   *  voided, and the event carries the invoice as it was then. */
  invoiceStatus: string | null;
}

/**
 * The decline facts of an invoice's latest charge, and the invoice's current status, for intake.
 * BEST EFFORT. Each half is null on any failure (no token, a decrypt failure, any Stripe error) and
 * logs it: intake must never be blocked by a read, and the caller falls back to what the event
 * carried.
 */
export async function resolveFailureFacts(
  env: Env,
  connectionId: string,
  invoiceId: string,
): Promise<FailureFacts> {
  let stripe: Stripe | null;
  try {
    stripe = await connectedStripeFor(env, connectionId);
  } catch (err) {
    console.error(
      "intake connection read failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return { decline: null, invoiceStatus: null };
  }
  if (!stripe) return { decline: null, invoiceStatus: null };
  let invoiceStatus: string | null = null;
  try {
    invoiceStatus = (await stripe.invoices.retrieve(invoiceId)).status ?? null;
  } catch (err) {
    console.error(
      "intake invoice read failed:",
      err instanceof Error ? err.message : "unknown error",
    );
  }
  return { decline: await readDeclineFacts(stripe, invoiceId), invoiceStatus };
}

async function readDeclineFacts(stripe: Stripe, invoiceId: string): Promise<DeclineFacts | null> {
  try {
    const latest = await latestInvoiceCharge(stripe, invoiceId);
    if (!latest) return null;
    const { paymentIntent, charge } = latest;
    const outcome = charge.outcome;
    const card = charge.payment_method_details?.card;
    return {
      declineCode: pickDeclineCode([
        paymentIntent.last_payment_error?.decline_code,
        outcome?.type === "issuer_declined" ? outcome.reason : null,
        charge.failure_code,
      ]),
      networkAdviceCode: outcome?.network_advice_code ?? null,
      networkDeclineCode: outcome?.network_decline_code ?? null,
      cardFunding: card?.funding ?? null,
      cardBrand: card?.brand ?? null,
      cardCountry: card?.country ?? null,
    };
  } catch (err) {
    console.error(
      "intake decline facts read failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }
}

/**
 * The fee and net of a paid invoice's charge, for the recovery record. BEST EFFORT, like
 * resolveFailureFacts. Null on any failure, and on a charge whose balance transaction Stripe has
 * not created yet: the recovery and its billing never wait on this read, and the columns stay null
 * for a later backfill.
 */
export async function resolveRecoveredChargeFee(
  env: Env,
  connectionId: string,
  invoiceId: string,
): Promise<RecoveredChargeFee | null> {
  try {
    const stripe = await connectedStripeFor(env, connectionId);
    if (!stripe) return null;
    const latest = await latestInvoiceCharge(stripe, invoiceId, { balanceTransaction: true });
    const bt = latest?.charge.balance_transaction;
    if (!bt || typeof bt === "string") return null;
    return {
      stripeBalanceTransactionId: bt.id,
      stripeFeeCents: bt.fee,
      netAmountCents: bt.net,
      netCurrency: bt.currency,
    };
  } catch (err) {
    console.error(
      "recovered charge fee read failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }
}
