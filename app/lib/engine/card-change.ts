// Guard on an expired card's day 21 retry. Mastercard forbids another authorization on an expired-card decline
// with the same PAN and expiry, and Visa expects updated details first, so the retry charges only when the
// card differs from the declined one: a new expiry (Stripe's card updater), a new fingerprint, or a customer
// update through the hosted card page. Anything unreadable is treated as unchanged: the safe failure is a
// skipped retry, never a forbidden charge. Read-only; the charge is executeRetryStep's.

import type Stripe from "stripe";

import { getDb } from "~/db";
import { hasCardUpdateSignal } from "~/lib/card-update/signal";
import { getConnectedStripe } from "~/lib/stripe/client";
import { asId } from "~/lib/stripe/ids";
import { latestInvoiceCharge } from "~/lib/stripe/invoice-charge";
import { decryptToken } from "~/lib/stripe/encryption";
import type { RetryStepContext } from "./retry-step";

export function retryNeedsChangedCard(declineCategory: string): boolean {
  return declineCategory === "expired";
}

/** What identifies a card for the network rule: its fingerprint and its expiry. */
export interface CardSnapshot {
  fingerprint: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export type CardChangeVerdict = "changed" | "unchanged" | "unverified";

/** True only when the current card provably differs from the declined one in number or expiry; a missing or
 *  unreadable side never counts as a change. Pure. */
export function cardChangedSinceDecline(
  declined: CardSnapshot | null,
  current: CardSnapshot | null,
): boolean {
  if (!declined || !current) return false;
  if (declined.fingerprint && current.fingerprint && declined.fingerprint !== current.fingerprint) {
    return true;
  }
  const expiryKnown =
    declined.expMonth != null &&
    declined.expYear != null &&
    current.expMonth != null &&
    current.expYear != null;
  return (
    expiryKnown && (declined.expMonth !== current.expMonth || declined.expYear !== current.expYear)
  );
}

/** The card last declined on this invoice, from the charge's own record (payment_method_details is fixed at
 *  charge time, so a card the updater changed later still shows the old expiry). */
async function declinedCard(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ snapshot: CardSnapshot; paymentMethodId: string | null } | null> {
  const latest = await latestInvoiceCharge(stripe, invoiceId);
  if (!latest) return null;
  const { charge } = latest;
  const card = charge.payment_method_details?.card;
  if (!card) return null;
  return {
    snapshot: {
      fingerprint: card.fingerprint ?? null,
      expMonth: card.exp_month ?? null,
      expYear: card.exp_year ?? null,
    },
    paymentMethodId: asId(charge.payment_method),
  };
}

export interface ChargeMethodSources {
  invoiceDefault: string | null;
  subscription: string | Pick<Stripe.Subscription, "default_payment_method"> | null;
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null;
}

/** The payment method Stripe will charge: the invoice's default, else the subscription's, else the
 *  customer's, each read from Stripe only when every earlier one is empty. */
export async function chargePaymentMethodId(
  stripe: Stripe,
  sources: ChargeMethodSources,
): Promise<string | null> {
  if (sources.invoiceDefault) return sources.invoiceDefault;
  if (sources.subscription) {
    const subscription =
      typeof sources.subscription === "string"
        ? await stripe.subscriptions.retrieve(sources.subscription)
        : sources.subscription;
    const fromSubscription = asId(subscription.default_payment_method);
    if (fromSubscription) return fromSubscription;
  }
  if (sources.customer) {
    const customer =
      typeof sources.customer === "string"
        ? await stripe.customers.retrieve(sources.customer)
        : sources.customer;
    if (!customer.deleted) {
      const fromCustomer = asId(customer.invoice_settings?.default_payment_method);
      if (fromCustomer) return fromCustomer;
    }
  }
  return null;
}

async function currentPaymentMethodId(
  stripe: Stripe,
  invoiceId: string,
  declinedPaymentMethodId: string | null,
): Promise<string | null> {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const resolved = await chargePaymentMethodId(stripe, {
    invoiceDefault: asId(invoice.default_payment_method),
    subscription: asId(invoice.parent?.subscription_details?.subscription),
    customer: asId(invoice.customer),
  });
  return resolved ?? declinedPaymentMethodId;
}

async function compareCardsWithClient(
  stripe: Stripe,
  invoiceId: string,
): Promise<CardChangeVerdict> {
  const declined = await declinedCard(stripe, invoiceId);
  if (!declined) return "unverified";
  const currentId = await currentPaymentMethodId(stripe, invoiceId, declined.paymentMethodId);
  if (!currentId) return "unverified";
  const pm = await stripe.paymentMethods.retrieve(currentId);
  const current: CardSnapshot | null = pm.card
    ? {
        fingerprint: pm.card.fingerprint ?? null,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      }
    : null;
  if (!current) return "unverified";
  return cardChangedSinceDecline(declined.snapshot, current) ? "changed" : "unchanged";
}

/** The live check. A customer update through the hosted card page is read from Foxhound's own card_update
 *  signal first (no Stripe call). Any read failure is "unverified", so the retry is skipped. */
export async function checkCardChanged(
  env: Env,
  ctx: RetryStepContext,
): Promise<CardChangeVerdict> {
  try {
    if (await hasCardUpdateSignal(getDb(env), ctx.failedPaymentId)) return "changed";
    const stripe = getConnectedStripe(await decryptToken(env, ctx.connectionAccessToken));
    return await compareCardsWithClient(stripe, ctx.invoiceId);
  } catch (err) {
    console.error(
      "expired retry card check failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return "unverified";
  }
}
