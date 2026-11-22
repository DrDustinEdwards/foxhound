import { and, eq, notInArray } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices } from "~/db";
import { getStripe } from "~/lib/stripe/client";
import { PLATFORM_CHARGES_ENABLED } from "./charges-switch";

// Platform billing: turn a computed billing_invoices row into a real Stripe
// invoice on Foxhound's OWN Stripe account (the merchant is a Customer there).
// Only fee line items are charged; adjustment lines (admin-audited goodwill or
// correction) are internal ledger entries and NEVER create a Stripe charge, and
// admin_granted subscription rows never touch Stripe either (PRICING.md).

export interface PlatformInvoiceLineInput {
  /** billing_line_items.type */
  type: string;
  /** Billed amount in the invoice currency's minor units. */
  amountCents: number;
  description: string;
  /**
   * Deterministic Stripe idempotency key for THIS line's invoiceItems.create.
   * Derived from the line's own evidence (the recovered payment, the dispute),
   * never from a run-scoped value, so the same line replays the same key on any
   * later retry.
   */
  idempotencyKey: string;
}

export interface CreatePlatformInvoiceInput {
  platformCustomerId: string;
  currency: string;
  lines: PlatformInvoiceLineInput[];
  /**
   * Our billing_invoices.id, attached as Stripe metadata for reconciliation.
   */
  billingInvoiceId: string;
  /**
   * billing_invoices.period_start: the month the invoice bills, named in its
   * Stripe description.
   */
  periodStart: Date;
  /**
   * Resolves the billing email (platform-customer.ts
   * lookupPlatformBillingEmail).
   */
  billingEmail?: () => Promise<string | null>;
}

export interface PlatformInvoiceResult {
  stripeInvoiceId: string;
  hostedInvoiceUrl: string | null;
}

/**
 * Line-item types charged through Stripe. adjustment lines are internal only.
 */
export const STRIPE_CHARGEABLE_TYPES = new Set(["recovery_fee", "dispute_fee", "subscription"]);

/**
 * The subset of line items that become Stripe invoice items (chargeable,
 * positive). Pure.
 */
export function chargeableLines(lines: PlatformInvoiceLineInput[]): PlatformInvoiceLineInput[] {
  return lines.filter((l) => STRIPE_CHARGEABLE_TYPES.has(l.type) && l.amountCents > 0);
}

/**
 * Deterministic Stripe idempotency keys derived from our own invoice row id: a
 * retry that re-calls createPlatformInvoice for the SAME billing_invoices row
 * replays these exact keys, so Stripe returns the original invoice instead of
 * creating a second one. Exported so a future retry sweep and its tests can
 * assert against the same derivation.
 */
export function platformInvoiceIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice:${billingInvoiceId}`;
}
export function platformInvoiceFinalizeIdempotencyKey(billingInvoiceId: string): string {
  return `platform-invoice-finalize:${billingInvoiceId}`;
}

/**
 * Per-LINE idempotency keys, the guard the invoice-level keys cannot provide.
 *
 * So a failure partway through the loop, followed by a retry of the whole
 * function, replayed the create key (Stripe returns the ORIGINAL invoice) and
 * then re-added every item that had already landed on it. That is the
 * duplicate-charge path, and it is reachable the first time the loop is longer
 * than one item and Stripe blips.
 */
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

/**
 * The Stripe key for one committed billing_line_items row. The first charge
 * (run.ts) and every retry (charge-retry.ts) both derive it here, so they can
 * never disagree. A fee line keys on its evidence, as above.
 */
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

/**
 * A Stripe error described by its type and code only. Stripe's own message can
 * repeat what it was sent, the billing email included, and these strings reach
 * console.error and the sweep's result reason. Pure.
 */
export function stripeErrorSummary(err: unknown): string {
  const e = (err ?? {}) as { type?: unknown; code?: unknown };
  const type = typeof e.type === "string" ? e.type : "error";
  return typeof e.code === "string" ? `${type} (${e.code})` : type;
}

const SEND_INVOICE_DAYS_UNTIL_DUE = 30;

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

/**
 * Creates + finalizes the platform Stripe invoice for one billing_invoices row.
 * The Stripe seam; deferred live to Phase 8.
 *
 * This means a mid-loop failure (line 2 of 3 throws) can never leave an
 * orphaned "pending" item that a LATER period's invoice.create call silently
 * sweeps in, the bug the previous items-then-invoice ordering was exposed to:
 * our own billing_invoices row would say a period was never billed while
 * Stripe's records showed it was, bundled into a different period's invoice.
 */
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
    // Stripe can email the invoice only to an address on the customer. Fill it
    // in before anything is created; with none to be found, stop here so the
    // row stays draft rather than finalizing an invoice nobody receives.
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
            days_until_due: SEND_INVOICE_DAYS_UNTIL_DUE,
          }
        : { collection_method: "charge_automatically" as const }),
      // Held as a draft while items attach, on both paths: a half-built invoice
      // must never advance, and for send_invoice never be emailed. The finalize
      // below turns auto_advance on, which is when Stripe collects.
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

  // auto_advance on: Stripe now charges the card on file, or emails the invoice
  // when there is none. The retry sweep never re-creates an invoice Stripe
  // already has (findPlatformInvoiceByBillingId), so this is the one invoice
  // Stripe collects on.
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id, FINALIZE_PARAMS, {
    idempotencyKey: platformInvoiceFinalizeIdempotencyKey(input.billingInvoiceId),
  });
  return {
    stripeInvoiceId: finalized.id ?? invoice.id,
    hostedInvoiceUrl: finalized.hosted_invoice_url ?? null,
  };
}

/**
 * Find an already-created platform invoice for one of our billing_invoices
 * rows, by the metadata createPlatformInvoice stamps on it. Returns null when
 * Stripe has none.
 *
 * This exists because Stripe idempotency keys EXPIRE AFTER 24 HOURS and the
 * charge-retry sweep runs monthly. Replaying platformInvoiceIdempotencyKey a
 * month later does not return the original invoice, it creates a second one, so
 * for the review-findings scenario-2 stranding (Stripe charged, our follow-up
 * ref-update write failed, our row still says draft with no stripe_invoice_id)
 * a key-only retry would double-charge the merchant.
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

/**
 * Finalize an existing platform invoice that is still a Stripe DRAFT.
 *
 * Reachable whenever createPlatformInvoice got as far as attaching items and
 * then threw on its own finalize call: Stripe keeps the draft with the items on
 * it, our row stays 'draft', and the invoice is stranded. A draft cannot be
 * paid, so the retry sweep has to finalize before it can collect.
 */
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

/**
 * Attempt collection on an existing platform invoice, now. The retry sweep's
 * explicit attempt on an invoice still open a month on. Stripe pays an invoice
 * at most once, so this can fail against an invoice Stripe already collected
 * but never charge it twice.
 */
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
    // Per-ATTEMPT key: two different attempts must really be two attempts, but
    // a redelivered/duplicated single attempt must not double-charge.
    { idempotencyKey: `platform-invoice-pay:${stripeInvoiceId}:${attemptNumber}` },
  );
}

/**
 * The money-write that stamps the Stripe invoice reference + status onto our
 * billing_invoices row. Rides the per-account money-write DO like every other
 * billing write.
 */
/**
 * Statuses Stripe itself settled. A later write from our side (an attempt that
 * raced a payment, an eventually consistent search) never moves an invoice out
 * of one; only the platform webhook moves invoice status forward.
 */
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

/**
 * Deterministic key for the credit note that brings ONE fee line's credit up to
 * `creditedTotalCents`. A redelivered refund replays the same key and Stripe
 * returns the original note; a later, larger refund is a new total and so a new
 * note.
 */
export function creditNoteIdempotencyKey(lineItemId: string, creditedTotalCents: number): string {
  return `credit-note:${lineItemId}:${creditedTotalCents}`;
}

export interface CreditNoteInput {
  /** The Stripe invoice the fee was charged on. */
  stripeInvoiceId: string;
  /**
   * What this fee line's credit should come to in all, in minor units: the
   * whole fee for a full refund or a chargeback, the refunded share for a
   * partial refund.
   */
  creditedTotalCents: number;
  /**
   * Our billing_line_items.id for the fee, for the key and for reconciliation.
   */
  feeLineItemId: string;
  memo: string;
}

/**
 * Credit a fee line back on the platform invoice it was charged on, up to
 * `creditedTotalCents` in all.
 *
 * `credit_amount` is Stripe's "apply this to the customer's balance" mode, as
 * opposed to `refund_amount`, which moves cash. That is the whole point of the
 * ruling: Stripe holds the credit against the customer in THAT currency and
 * draws it down on their next finalized invoice, so no money leaves and no card
 * is touched.
 */
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
