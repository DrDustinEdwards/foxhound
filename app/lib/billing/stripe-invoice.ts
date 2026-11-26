import { and, eq, notInArray } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices } from "~/db";
import { getStripe } from "~/lib/stripe/client";
import { PLATFORM_CHARGES_ENABLED } from "./charges-switch";
import { INVOICE_DAYS_UNTIL_DUE } from "~/lib/constants";

// Turn a billing_invoices row into a Stripe invoice on Foxhound's OWN account. Only fee lines are charged; adjustment lines and admin_granted subscriptions never touch Stripe (PRICING.md).

export interface PlatformInvoiceLineInput {
  /** billing_line_items.type */
  type: string;
  /** Billed amount in the invoice currency's minor units. */
  amountCents: number;
  description: string;
  /** Idempotency key for this line's invoiceItems.create, derived from its evidence, never a run-scoped value. */
  idempotencyKey: string;
}

export interface CreatePlatformInvoiceInput {
  platformCustomerId: string;
  currency: string;
  lines: PlatformInvoiceLineInput[];
  /** Our billing_invoices.id, as Stripe metadata. */
  billingInvoiceId: string;
  /** billing_invoices.period_start, named in the Stripe description. */
  periodStart: Date;
  /** Resolves the billing email (lookupPlatformBillingEmail). */
  billingEmail?: () => Promise<string | null>;
}

export interface PlatformInvoiceResult {
  stripeInvoiceId: string;
  hostedInvoiceUrl: string | null;
}

/** Line-item types charged through Stripe. */
export const STRIPE_CHARGEABLE_TYPES = new Set(["recovery_fee", "dispute_fee", "subscription"]);

/** Line items that become Stripe invoice items (chargeable, positive). Pure. */
export function chargeableLines(lines: PlatformInvoiceLineInput[]): PlatformInvoiceLineInput[] {
  return lines.filter((l) => STRIPE_CHARGEABLE_TYPES.has(l.type) && l.amountCents > 0);
}

/** Idempotency keys from our invoice row id: a retry for the same row replays them, so Stripe returns the original invoice. */
export function platformInvoiceIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice:${billingInvoiceId}`;
}
export function platformInvoiceFinalizeIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice-finalize:${billingInvoiceId}`;
}

/** Per-LINE idempotency keys: without them a retry after a mid-loop failure re-adds items already on the original invoice (duplicate charge). */
export function recoveryFeeItemIdempotencyKey(
  accountId: string,
  periodKey: string,
  currency: string,
  recoveredPaymentId: string,
): string {
  return `recovery_fee_item_${accountId}_${periodKey}_${currency}_${recoveredPaymentId}`;
}
export function disputeFeeItemIdempotencyKey(disputeId: string): string {
  return `dispute_fee_item_${disputeId}`;
}

/** The Stripe key for one committed line row; run.ts and charge-retry.ts both derive it here so they never disagree. */
export function lineItemIdempotencyKey(
  row: { id: string; type: string; recoveredPaymentId: string | null; disputeId: string | null },
  ctx: { accountId: string; periodKey: string; currency: string },
): string {
  if (row.type === "recovery_fee" && row.recoveredPaymentId) {
    return recoveryFeeItemIdempotencyKey(
      ctx.accountId,
      ctx.periodKey,
      ctx.currency,
      row.recoveredPaymentId,
    );
  }
  if (row.type === "dispute_fee" && row.disputeId)
    return disputeFeeItemIdempotencyKey(row.disputeId);
  return `line_item_${row.id}`;
}

/** A Stripe error as type and code only: its message can repeat the billing email and these strings reach logs. Pure. */
export function stripeErrorSummary(err: unknown): string {
  const e = (err ?? {}) as { type?: unknown; code?: unknown };
  const type = typeof e.type === "string" ? e.type : "error";
  return typeof e.code === "string" ? `${type} (${e.code})` : type;
}

/** The slice of a retrieved platform customer the collection choice reads. */
interface CustomerPaymentMethodFields {
  deleted?: boolean | void;
  email?: string | null;
  invoice_settings?: { default_payment_method?: unknown } | null;
  default_source?: unknown;
}

function hasDefaultPaymentMethod(customer: CustomerPaymentMethodFields): boolean {
  if (customer.deleted) return false;
  return Boolean(customer.invoice_settings?.default_payment_method || customer.default_source);
}

function platformInvoiceDescription(periodStart: Date): string {
  const month = periodStart.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Foxhound: ${month}`;
}

const FINALIZE_PARAMS: Stripe.InvoiceFinalizeInvoiceParams = { auto_advance: true };

/** Creates and finalizes the platform Stripe invoice for one billing_invoices row. A mid-loop failure must not orphan a pending item that a later period's invoice would sweep in. */
export async function createPlatformInvoice(
  env: Env,
  input: CreatePlatformInvoiceInput,
): Promise<PlatformInvoiceResult> {
  if (!PLATFORM_CHARGES_ENABLED) throw new Error("platform charges are switched off");
  const lines = chargeableLines(input.lines);
  if (lines.length === 0) {
    throw new Error("no chargeable line items for platform invoice");
  }
  if (!input.platformCustomerId) {
    throw new Error("no platform customer id for account billing");
  }
  const stripe = getStripe(env); // throws if STRIPE_SECRET_KEY unset

  const customer = await stripe.customers.retrieve(input.platformCustomerId);
  const sendByEmail = !hasDefaultPaymentMethod(customer);
  if (sendByEmail && !("email" in customer && customer.email)) {
    // Stripe emails only to an address on the customer. With none, stop so the row stays draft.
    const email = input.billingEmail ? await input.billingEmail() : null;
    if (!email) throw new Error("no billing email for an emailed platform invoice");
    try {
      await stripe.customers.update(input.platformCustomerId, { email });
    } catch (err) {
      throw new Error(`platform customer email update failed: ${stripeErrorSummary(err)}`);
    }
  }

  const invoice = await stripe.invoices.create(
    {
      customer: input.platformCustomerId,
      currency: input.currency,
      description: platformInvoiceDescription(input.periodStart),
      ...(sendByEmail
        ? {
            collection_method: "send_invoice" as const,
            days_until_due: INVOICE_DAYS_UNTIL_DUE,
          }
        : { collection_method: "charge_automatically" as const }),
      // Draft while items attach: a half-built invoice must never advance or be emailed. Finalize turns auto_advance on.
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
    await stripe.invoiceItems.create(
      {
        customer: input.platformCustomerId,
        invoice: invoice.id,
        currency: input.currency,
        amount: line.amountCents,
        description: line.description,
      },
      { idempotencyKey: line.idempotencyKey },
    );
  }

  // auto_advance on: Stripe now charges the card or emails the invoice.
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id, FINALIZE_PARAMS, {
    idempotencyKey: platformInvoiceFinalizeIdempotencyKey(input.billingInvoiceId),
  });
  return {
    stripeInvoiceId: finalized.id ?? invoice.id,
    hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
  };
}

/**
 * Find an existing platform invoice by the metadata createPlatformInvoice stamps; null when none.
 * Needed because idempotency keys expire after 24 hours and the retry sweep runs monthly: a key-only retry of a stranded row (Stripe charged, our ref write failed) would double-charge.
 */
export async function findPlatformInvoiceByBillingId(
  env: Env,
  billingInvoiceId: string,
): Promise<Stripe.Invoice | null> {
  const stripe = getStripe(env);
  const results = await stripe.invoices.search({
    query: `metadata['billing_invoice_id']:'${billingInvoiceId}'`,
    limit: 1,
  });
  return results.data[0] ?? null;
}

/** Finalize a stranded Stripe DRAFT (createPlatformInvoice threw on finalize); a draft cannot be paid. */
export async function finalizePlatformInvoice(
  env: Env,
  stripeInvoiceId: string,
  billingInvoiceId: string,
): Promise<Stripe.Invoice> {
  const stripe = getStripe(env);
  return stripe.invoices.finalizeInvoice(stripeInvoiceId, FINALIZE_PARAMS, {
    idempotencyKey: platformInvoiceFinalizeIdempotencyKey(billingInvoiceId),
  });
}

/** Attempt collection now (the retry sweep). Stripe pays an invoice at most once, so this never double-charges. */
export async function payPlatformInvoice(
  env: Env,
  stripeInvoiceId: string,
  attemptNumber: number,
): Promise<Stripe.Invoice> {
  if (!PLATFORM_CHARGES_ENABLED) throw new Error("platform charges are switched off");
  const stripe = getStripe(env);
  return stripe.invoices.pay(
    stripeInvoiceId,
    {},
    // Per-attempt key: distinct attempts stay distinct, a redelivered one does not double-charge.
    { idempotencyKey: `platform-invoice-pay:${stripeInvoiceId}:${attemptNumber}` },
  );
}

/** Statuses Stripe settled; only the platform webhook moves an invoice out of one. */
export const STRIPE_SETTLED_STATUSES = ["paid", "void", "uncollectible"];

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
      .where(
        and(
          eq(billingInvoices.id, input.billingInvoiceId),
          notInArray(billingInvoices.status, STRIPE_SETTLED_STATUSES),
        ),
      ),
  ];
}

/** Key for the credit note bringing ONE fee line's credit up to `creditedTotalCents`; a larger later refund is a new total, so a new note. */
export function creditNoteIdempotencyKey(lineItemId: string, creditedTotalCents: number): string {
  return `credit-note:${lineItemId}:${creditedTotalCents}`;
}

export interface CreditNoteInput {
  /** The Stripe invoice the fee was charged on. */
  stripeInvoiceId: string;
  /** The fee line's total credit, minor units: whole fee for a full refund or chargeback, else the refunded share. */
  creditedTotalCents: number;
  /** Our billing_line_items.id, for the key and reconciliation. */
  feeLineItemId: string;
  memo: string;
}

/** Credit a fee line back on its platform invoice, up to `creditedTotalCents`. `credit_amount` applies to the customer's balance (not `refund_amount`, which moves cash), so no card is touched. */
export async function createCreditNote(
  env: Env,
  input: CreditNoteInput,
): Promise<{ creditNoteId: string }> {
  const stripe = getStripe(env);
  let credited = 0;
  let latest: string | null = null;
  for await (const existing of stripe.creditNotes.list({
    invoice: input.stripeInvoiceId,
    limit: 100,
  })) {
    if (existing.metadata?.fee_line_item_id !== input.feeLineItemId) continue;
    if (existing.status === "void") {
      throw new Error(
        `credit note ${existing.id} for fee line ${input.feeLineItemId} was voided at Stripe`,
      );
    }
    credited += existing.amount ?? 0;
    latest ??= existing.id;
  }
  if (latest && credited >= input.creditedTotalCents) return { creditNoteId: latest };
  const note = await stripe.creditNotes.create(
    {
      invoice: input.stripeInvoiceId,
      credit_amount: input.creditedTotalCents - credited,
      memo: input.memo,
      metadata: {
        fee_line_item_id: input.feeLineItemId,
        credited_total: String(input.creditedTotalCents),
      },
    },
    { idempotencyKey: creditNoteIdempotencyKey(input.feeLineItemId, input.creditedTotalCents) },
  );
  if (!note.id) throw new Error("stripe credit note create returned no id");
  return { creditNoteId: note.id };
}
