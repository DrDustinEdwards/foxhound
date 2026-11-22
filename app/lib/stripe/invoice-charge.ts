import type Stripe from "stripe";

import { asId } from "./ids";
import { collectPaginated } from "./reads";

// The latest charge attempted on an invoice. Read-only.

/**
 * The newest payment intent on the invoice and its latest charge, or null when the invoice has no
 * payment intent or the charge is missing.
 */
export async function latestInvoiceCharge(
  stripe: Stripe,
  invoiceId: string,
  options: { balanceTransaction?: boolean } = {},
): Promise<{ paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge } | null> {
  const payments = await collectPaginated(
    stripe.invoicePayments.list({ invoice: invoiceId }),
    (p) => ({
      created: p.created,
      paymentIntentId: asId(p.payment.payment_intent),
    }),
  );
  const latest = payments.filter((p) => p.paymentIntentId).sort((a, b) => b.created - a.created)[0];
  if (!latest?.paymentIntentId) return null;
  const paymentIntent = await stripe.paymentIntents.retrieve(latest.paymentIntentId, {
    expand: options.balanceTransaction
      ? ["latest_charge", "latest_charge.balance_transaction"]
      : ["latest_charge"],
  });
  const charge = paymentIntent.latest_charge;
  if (!charge || typeof charge === "string") return null;
  return { paymentIntent, charge };
}
