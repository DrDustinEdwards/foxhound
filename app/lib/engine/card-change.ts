// The guard on an expired card's day 21 retry (Dustin, 2026-10-25, decision
// card "Yes, all three", on research/dunning-wording-and-timing-2026-10-15.md).
//
// Recova retried an expired card on day 21 whatever had happened to it.
// Mastercard forbids a further authorization on an expired-card decline "with
// the same PAN and expiration date, at any time", and Visa expects updated
// details first. So the retry is kept, but it charges only when the card the
// invoice will be paid with differs from the card that was declined: a new
// expiry on the same card (Stripe's card updater, which is what
// payment_method.automatically_updated reports), a different card number (a new
// fingerprint), or a customer update through Foxhound's hosted card page.
// Otherwise the step is skipped. Anything that cannot be read is treated as
// unchanged, because the safe failure is a skipped retry, never a charge the
// network forbids.
//
// Read-only: this module makes no charge and writes nothing. The charge, when
// there is one, is executeRetryStep's, with its idempotency key, and the
// recovery is still recorded only by the webhook through the money DO.

import type Stripe from "stripe";

import { getDb } from "~/db";
import { hasCardUpdateSignal } from "~/lib/card-update/signal";
import { collectPaginated } from "~/lib/stripe/reads";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import type { RetryStepContext } from "./retry-step";

/** The decline categories whose retry is guarded on a changed card. */
export function retryNeedsChangedCard(declineCategory: string): boolean {
  return declineCategory === "expired";
}

/** What identifies a card for the network rule: its number (by Stripe's
 *  fingerprint) and its expiry. */
export interface CardSnapshot {
  fingerprint: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export type CardChangeVerdict = "changed" | "unchanged" | "unverified";

/**
 * True only when the current card provably differs from the declined one in
 * number or expiry. A side that cannot be read, or a field missing on either
 * side, never counts as a change. Pure.
 */
export function cardChangedSinceDecline(
  declined: CardSnapshot | null,
  current: CardSnapshot | null,
): boolean {
  if (!declined || !current) return false;
  if (declined.fingerprint && current.fingerprint && declined.fingerprint !== current.fingerprint) {
    return true;
  }
  const expiryKnown =
    declined.expMonth != null && declined.expYear != null && current.expMonth != null && current.expYear != null;
  return expiryKnown && (declined.expMonth !== current.expMonth || declined.expYear !== current.expYear);
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** The card that was last declined on this invoice, from the charge's own
 *  record of it (payment_method_details is fixed at charge time, so a card the
 *  updater changed later still shows the old expiry here). */
async function declinedCard(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ snapshot: CardSnapshot; paymentMethodId: string | null } | null> {
  const payments = await collectPaginated(stripe.invoicePayments.list({ invoice: invoiceId }), (p) => ({
    created: p.created,
    paymentIntentId: idOf(p.payment.payment_intent),
  }));
  const latest = payments
    .filter((p) => p.paymentIntentId)
    .sort((a, b) => b.created - a.created)[0];
  if (!latest?.paymentIntentId) return null;
  const intent = await stripe.paymentIntents.retrieve(latest.paymentIntentId, { expand: ["latest_charge"] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge === "string") return null;
  const card = charge.payment_method_details?.card;
  if (!card) return null;
  return {
    snapshot: { fingerprint: card.fingerprint ?? null, expMonth: card.exp_month ?? null, expYear: card.exp_year ?? null },
    paymentMethodId: idOf(charge.payment_method),
  };
}

/** The payment method invoices.pay will use: the invoice's own default, else
 *  the subscription's, else the customer's, else the declined one (which the
 *  card updater may have changed in place). */
async function currentPaymentMethodId(
  stripe: Stripe,
  invoiceId: string,
  declinedPaymentMethodId: string | null,
): Promise<string | null> {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const own = idOf(invoice.default_payment_method);
  if (own) return own;
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const fromSubscription = idOf(subscription.default_payment_method);
    if (fromSubscription) return fromSubscription;
  }
  const customerId = idOf(invoice.customer);
  if (customerId) {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
      const fromCustomer = idOf(customer.invoice_settings?.default_payment_method);
      if (fromCustomer) return fromCustomer;
    }
  }
  return declinedPaymentMethodId;
}

/** Compare the declined card with the one the retry would charge. Read-only. */
async function compareCardsWithClient(stripe: Stripe, invoiceId: string): Promise<CardChangeVerdict> {
  const declined = await declinedCard(stripe, invoiceId);
  if (!declined) return "unverified";
  const currentId = await currentPaymentMethodId(stripe, invoiceId, declined.paymentMethodId);
  if (!currentId) return "unverified";
  const pm = await stripe.paymentMethods.retrieve(currentId);
  const current: CardSnapshot | null = pm.card
    ? { fingerprint: pm.card.fingerprint ?? null, expMonth: pm.card.exp_month, expYear: pm.card.exp_year }
    : null;
  if (!current) return "unverified";
  return cardChangedSinceDecline(declined.snapshot, current) ? "changed" : "unchanged";
}

/**
 * The live check. A customer update through the hosted card page is read from
 * Foxhound's own card_update signal first, which needs no Stripe call; Stripe
 * is read only when there is none. Any read failure is "unverified", so the
 * retry is skipped rather than risked.
 */
export async function checkCardChanged(env: Env, ctx: RetryStepContext): Promise<CardChangeVerdict> {
  try {
    if (await hasCardUpdateSignal(getDb(env), ctx.failedPaymentId)) return "changed";
    const stripe = getConnectedStripe(await decryptToken(env, ctx.connectionAccessToken));
    return await compareCardsWithClient(stripe, ctx.invoiceId);
  } catch (err) {
    console.error("expired retry card check failed:", err instanceof Error ? err.message : "unknown error");
    return "unverified";
  }
}
