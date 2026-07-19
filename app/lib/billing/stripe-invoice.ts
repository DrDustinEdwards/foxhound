import { eq } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices } from "~/db";
import { getStripe } from "~/lib/stripe/client";

// Platform billing: turn a computed billing_invoices row into a real Stripe
// invoice on Foxhound's OWN Stripe account (the merchant is a Customer there).
// Only fee line items are charged; adjustment lines (admin-audited goodwill or
// correction) are internal ledger entries and NEVER create a Stripe charge, and
// admin_granted subscription rows never touch Stripe either (PRICING.md).
//
// LIVE sends are deferred to Phase 8: they need the platform Stripe test key AND
// the merchant's platform customer id, which Phase 5 billing-setup collects (no
// column stores it yet). The line-selection + status math here are unit-proven;
// createPlatformInvoice throws unless its preconditions hold, so the billing run
// never charges by accident. The run computes the ledger; charge dispatch is a
// separate, later step wired once the customer mapping exists.

export interface PlatformInvoiceLineInput {
  /** billing_line_items.type */
  type: string;
  /** Billed amount in the invoice currency's minor units. */
  amountCents: number;
  description: string;
}

export interface CreatePlatformInvoiceInput {
  platformCustomerId: string;
  currency: string;
  lines: PlatformInvoiceLineInput[];
  /** Our billing_invoices.id, attached as Stripe metadata for reconciliation. */
  billingInvoiceId: string;
}

export interface PlatformInvoiceResult {
  stripeInvoiceId: string;
  hostedInvoiceUrl: string | null;
}

/** Line-item types charged through Stripe. adjustment lines are internal only. */
const STRIPE_CHARGEABLE_TYPES = new Set(["recovery_fee", "dispute_fee", "subscription"]);

/** The subset of line items that become Stripe invoice items (chargeable, positive). Pure. */
export function chargeableLines(lines: PlatformInvoiceLineInput[]): PlatformInvoiceLineInput[] {
  return lines.filter((l) => STRIPE_CHARGEABLE_TYPES.has(l.type) && l.amountCents > 0);
}

/** Deterministic Stripe idempotency keys derived from our own invoice row id
 *  (Phase 5 review HIGH fix + Phase 8 charge-dispatch-retry groundwork): a
 *  retry that re-calls createPlatformInvoice for the SAME billing_invoices
 *  row replays these exact keys, so Stripe returns the original invoice
 *  instead of creating a second one. Exported so a future retry sweep and its
 *  tests can assert against the same derivation. */
export function platformInvoiceIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice:${billingInvoiceId}`;
}
export function platformInvoiceFinalizeIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice-finalize:${billingInvoiceId}`;
}

/** Creates + finalizes the platform Stripe invoice for one billing_invoices row.
 *  The Stripe seam; deferred live to Phase 8. Guards ensure no accidental charge.
 *
 *  Invoice-first ordering (Phase 5 review HIGH fix, 2026-07-19): the invoice is
 *  created FIRST, as a draft, with pending_invoice_items_behavior explicitly
 *  set to 'exclude' (not left to the API version's default) and auto_advance
 *  off, then each chargeable line is created as an invoice item EXPLICITLY
 *  attached to that invoice's id. This means a mid-loop failure (line 2 of 3
 *  throws) can never leave an orphaned "pending" item that a LATER period's
 *  invoice.create call silently sweeps in, the bug the previous
 *  items-then-invoice ordering was exposed to: our own billing_invoices row
 *  would say a period was never billed while Stripe's records showed it was,
 *  bundled into a different period's invoice. */
export async function createPlatformInvoice(
  env: Env,
  input: CreatePlatformInvoiceInput,
): Promise<PlatformInvoiceResult> {
  const lines = chargeableLines(input.lines);
  if (lines.length === 0) {
    throw new Error("no chargeable line items for platform invoice");
  }
  if (!input.platformCustomerId) {
    throw new Error("no platform customer id for account billing");
  }
  const stripe = getStripe(env); // throws if STRIPE_SECRET_KEY unset

  const invoice = await stripe.invoices.create(
    {
      customer: input.platformCustomerId,
      currency: input.currency,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      metadata: { billing_invoice_id: input.billingInvoiceId },
    },
    { idempotencyKey: platformInvoiceIdempotencyKey(input.billingInvoiceId) },
  );
  if (!invoice.id) {
    throw new Error("stripe invoice create returned no id");
  }

  for (const line of lines) {
    await stripe.invoiceItems.create({
      customer: input.platformCustomerId,
      invoice: invoice.id,
      currency: input.currency,
      amount: line.amountCents,
      description: line.description,
    });
  }

  const finalized = await stripe.invoices.finalizeInvoice(
    invoice.id,
    undefined,
    { idempotencyKey: platformInvoiceFinalizeIdempotencyKey(input.billingInvoiceId) },
  );
  return {
    stripeInvoiceId: finalized.id ?? invoice.id,
    hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
  };
}

/** The money-write that stamps the Stripe invoice reference + status onto our
 *  billing_invoices row. Rides the per-account money-write DO like every other
 *  billing write. */
export function buildInvoiceStripeRefUpdate(
  db: Db,
  input: {
    billingInvoiceId: string;
    stripeInvoiceId: string;
    hostedInvoiceUrl: string | null;
    status: string;
    now: Date;
  },
): MoneyWriteBatch {
  return [
    db
      .update(billingInvoices)
      .set({
        stripeInvoiceId: input.stripeInvoiceId,
        stripeInvoiceUrl: input.hostedInvoiceUrl,
        status: input.status,
        finalizedAt: input.now,
      })
      .where(eq(billingInvoices.id, input.billingInvoiceId)),
  ];
}
