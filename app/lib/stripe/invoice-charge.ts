import type Stripe from "stripe";

import { collectPaginated } from "./reads";

// The latest charge attempted on an invoice. On the pinned API version an
// Invoice has no `charge` field, so the charge is reached through the
// invoice's payments: the newest payment intent, retrieved with its latest
// charge expanded. Read-only. Shared by the expired-card retry guard
// (engine/card-change.ts), webhook intake and the recovered-fee read
// (webhooks/lookups.ts).

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** The newest payment intent on the invoice and its latest charge, or null
 *  when the invoice has no payment intent or the charge is missing. Stripe
 *  errors propagate; each caller decides what a failed read means. With
 *  `balanceTransaction`, the charge's balance transaction comes expanded too,
 *  in the same call. */
export async function latestInvoiceCharge(
  stripe: Stripe,
  invoiceId: string,
  options: { balanceTransaction?: boolean } = {},
): Promise<{ paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge } | null> {
  const payments = await collectPaginated(stripe.invoicePayments.list({ invoice: invoiceId }), (p) => ({
    created: p.created,
    paymentIntentId: idOf(p.payment.payment_intent),
  }));
  const latest = payments
    .filter((p) => p.paymentIntentId)
    .sort((a, b) => b.created - a.created)[0];
  if (!latest?.paymentIntentId) return null;
  const paymentIntent = await stripe.paymentIntents.retrieve(latest.paymentIntentId, {
    expand: options.balanceTransaction ? ["latest_charge", "latest_charge.balance_transaction"] : ["latest_charge"],
  });
  const charge = paymentIntent.latest_charge;
  if (!charge || typeof charge === "string") return null;
  return { paymentIntent, charge };
}
