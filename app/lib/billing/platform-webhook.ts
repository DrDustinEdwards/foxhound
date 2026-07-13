import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { billingInvoices, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

// Reconciliation for Foxhound's OWN Stripe invoices (the ones we raise against
// merchants for fees). The platform webhook (/webhooks/stripe-platform) claims
// each event exactly-once, then dispatches billing-invoice status events here.
// We match our billing_invoices row by the billing_invoice_id metadata stamped at
// creation, and route the status update through the per-account money-write DO so
// every billing write stays serialized.
//
// LIVE events arrive only once createPlatformInvoice is wired (Phase 8); the
// status mapping + matching are unit-proven now.

const PLATFORM_STATUS: Record<string, string> = {
  "invoice.finalized": "finalized",
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.marked_uncollectible": "uncollectible",
  "invoice.voided": "void",
};

/** Maps a platform Stripe event type to our billing_invoices status (null = ignore). Pure. */
export function platformBillingStatus(eventType: string): string | null {
  return PLATFORM_STATUS[eventType] ?? null;
}

/** Applies one platform billing event to the matching billing_invoices row. */
export async function processPlatformBillingEvent(
  env: Env,
  event: Stripe.Event,
): Promise<"updated" | "ignored"> {
  const status = platformBillingStatus(event.type);
  if (!status) return "ignored";

  const invoice = event.data.object as Stripe.Invoice;
  const billingInvoiceId = invoice.metadata?.billing_invoice_id ?? null;
  if (!billingInvoiceId) return "ignored";

  const db = getDb(env);
  const rows = await db
    .select({ accountId: billingInvoices.accountId })
    .from(billingInvoices)
    .where(eq(billingInvoices.id, billingInvoiceId))
    .limit(1);
  const accountId = rows[0]?.accountId;
  if (!accountId) return "ignored";

  await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: `billing-status:${event.id}`,
    build: (bdb) => [
      bdb
        .update(billingInvoices)
        .set({
          status,
          stripeInvoiceId: invoice.id ?? null,
          stripeInvoiceUrl: invoice.hosted_invoice_url ?? null,
          finalizedAt: new Date(),
        })
        .where(eq(billingInvoices.id, billingInvoiceId)),
    ],
  });
  return "updated";
}
