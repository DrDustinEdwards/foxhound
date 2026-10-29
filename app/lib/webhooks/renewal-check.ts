// The renewal card check: invoice.upcoming (a subscription is about to renew)
// and customer.subscription.trial_will_end (a trial converts in three days).
// Both ask one question before the charge happens: will the payment method
// Stripe is about to charge work on that date? Dispatched from process.ts.
//
// IT IS A THIRD WRITER OF THE EXPIRING-CARD TABLE, not a parallel system. It
// records through buildCandidateUpsert, the same upsert the nightly scan and
// customer.updated use, so the unique card-month tuple dedupes across all
// three, a soft-deleted row still blocks, and the nightly send pass owns every
// email, applying the account's expiring-card setting, suppression and the
// live-send gate exactly as it does for the other two. This file never sends.
//
// What differs from the other writers is only the window. They record a card
// expiring inside the fixed lead window; this records a card that expires
// before the actual charge date, however far out that is.

import { eq } from "drizzle-orm";

import { getDb, stripeConnections } from "~/db";
import { buildCandidateUpsert, expiresBeforeCharge, type CandidateInput } from "~/lib/cron/expiring-cards";
import { chargePaymentMethodId } from "~/lib/engine/card-change";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import { buildClaimOnlyBatch } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";

type RenewalIntent = IntentOf<"renewal_card_check">;

/** What the Stripe reads found, before any date is compared. */
type RenewalCharge =
  | { kind: "card"; email: string; name: string | null; expMonth: number; expYear: number; brand: string | null; last4: string | null }
  | { kind: "no_payment_method"; email: string; name: string | null }
  | { kind: "skip"; reason: string };

/**
 * Read the customer and the payment method the charge will use, in
 * card-change.ts's resolution order. The customer is read once and handed to
 * that resolver, since its email and its default are both needed.
 *
 * "No payment method" also requires no legacy default source on the customer:
 * Stripe falls back to one when nothing else is set, and calling such a
 * customer cardless would put an untrue sentence in their inbox.
 */
async function resolveRenewalCharge(env: Env, connectionId: string, intent: RenewalIntent): Promise<RenewalCharge> {
  const [connection] = await getDb(env)
    .select({ accessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId))
    .limit(1);
  if (!connection?.accessToken) return { kind: "skip", reason: "no_connection_token" };
  const stripe = getConnectedStripe(await decryptToken(env, connection.accessToken));

  const customer = await stripe.customers.retrieve(intent.customerId);
  if (customer.deleted) return { kind: "skip", reason: "customer_deleted" };
  const email = intent.customerEmail || customer.email;
  // No address, no email to send, as the nightly scan refuses it.
  if (!email) return { kind: "skip", reason: "no_customer_email" };
  const name = intent.customerName ?? customer.name ?? null;

  const pmId = await chargePaymentMethodId(stripe, {
    invoiceDefault: intent.invoiceDefault,
    subscription: intent.subscription,
    customer,
  });
  if (!pmId) {
    return customer.default_source ? { kind: "skip", reason: "legacy_source" } : { kind: "no_payment_method", email, name };
  }
  const pm = await stripe.paymentMethods.retrieve(pmId);
  // A bank debit or wallet balance has no expiry to check.
  if (!pm.card?.exp_month || !pm.card?.exp_year) return { kind: "skip", reason: "not_a_card" };
  return {
    kind: "card",
    email,
    name,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
    brand: pm.card.brand ?? null,
    last4: pm.card.last4 ?? null,
  };
}

/** The candidate this event should record, or why it records none. Only the
 *  trial check records a missing payment method: that is the case where the
 *  first charge has never had a card behind it. */
function candidateFor(
  intent: RenewalIntent,
  charge: RenewalCharge,
  now: Date,
): { candidate: Omit<CandidateInput, "accountId" | "connectionId"> } | { reason: string } {
  if (charge.kind === "skip") return { reason: charge.reason };
  const base = { stripeCustomerId: intent.customerId, customerEmail: charge.email, customerName: charge.name };
  if (charge.kind === "no_payment_method") {
    if (intent.source !== "trial_will_end") return { reason: "no_payment_method" };
    return {
      candidate: {
        ...base,
        cardBrand: null,
        cardLast4: null,
        // The trial end month: see the reason column in app/db/schema/recovery.ts.
        expiresMonth: intent.chargeAt.getUTCMonth() + 1,
        expiresYear: intent.chargeAt.getUTCFullYear(),
        reason: "no_payment_method",
      },
    };
  }
  if (!expiresBeforeCharge(charge.expMonth, charge.expYear, now, intent.chargeAt)) {
    return { reason: "card_valid_at_charge" };
  }
  return {
    candidate: {
      ...base,
      cardBrand: charge.brand,
      cardLast4: charge.last4,
      expiresMonth: charge.expMonth,
      expiresYear: charge.expYear,
    },
  };
}

export async function handleRenewalCardCheck(ctx: WebhookContext, intent: RenewalIntent): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  let charge: RenewalCharge;
  try {
    charge = await resolveRenewalCharge(env, connectionId, intent);
  } catch (err) {
    // As customer.updated's lookup: a Stripe failure loses one check and never
    // fails the webhook. A card case is found again by the nightly scan once
    // it is inside the lead window.
    console.error("renewal card check lookup failed:", err instanceof Error ? err.message : err);
    charge = { kind: "skip", reason: "stripe_read_failed" };
  }

  const decision = candidateFor(intent, charge, receivedAt);
  if (!("candidate" in decision)) {
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied ? { status: "ignored", reason: decision.reason } : { status: "duplicate" };
  }

  // The claim and the upsert ride one batch, as customer.updated's do, so a
  // replayed event cannot double-write.
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => [
      ...buildClaimOnlyBatch(db, claim),
      buildCandidateUpsert(db, { accountId, connectionId, ...decision.candidate }, receivedAt),
    ],
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}
