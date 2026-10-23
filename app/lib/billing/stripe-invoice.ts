import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices } from "~/db";
import { getStripe } from "~/lib/stripe/client";

// Platform billing: turn a computed billing_invoices row into a real Stripe
// invoice on Foxhound's OWN Stripe account (the merchant is a Customer there).
// Only fee line items are charged; adjustment lines (admin-audited goodwill or
// correction) are internal ledger entries and NEVER create a Stripe charge, and
// admin_granted subscription rows never touch Stripe either (PRICING.md).
//
// Corrected 2026-08-11. This block used to say the merchant's platform customer
// id had "no column stores it yet" and that charge dispatch was "a separate,
// later step wired once the customer mapping exists". Both were false, and had
// been for some time.
//
// accounts.platform_stripe_customer_id has existed since migration
// 0005_stormy_vector.sql and is present in every snapshot through 0012.
// Billing-setup populates it through a single write path,
// app/routes/app/billing/index.tsx:101, persisted before the redirect out to
// Stripe Checkout so the return leg's ownership check has an account-bound
// value to compare. Charge dispatch is wired: run.ts:358 and
// charge-retry.ts:297.
//
// THE PHASE 5 GATE IS SATISFIED. It was believed open, and this stale comment
// is the most likely reason, so anything sequenced behind "Phase 5 collects the
// customer id" should be re-examined rather than assumed still blocked.
//
// What genuinely remains for live charges is the platform Stripe key and the
// deliberate decision to turn dispatch on. The line-selection and status math
// here are unit-proven, and createPlatformInvoice throws unless its
// preconditions hold, so the billing run still never charges by accident.

export interface PlatformInvoiceLineInput {
  /** billing_line_items.type */
  type: string;
  /** Billed amount in the invoice currency's minor units. */
  amountCents: number;
  description: string;
  /** Deterministic Stripe idempotency key for THIS line's invoiceItems.create.
   *  Derived from the line's own evidence (the recovered payment, the dispute),
   *  never from a run-scoped value, so the same line replays the same key on any
   *  later retry. Built by the helpers below; see their comment for why per-item
   *  keys are load-bearing rather than belt-and-braces. */
  idempotencyKey: string;
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

/** Per-LINE idempotency keys, the guard the invoice-level keys cannot provide.
 *
 *  createPlatformInvoice is create -> N items -> finalize. The create and
 *  finalize calls carry keys; the item calls carried NONE. So a failure partway
 *  through the loop, followed by a retry of the whole function, replayed the
 *  create key (Stripe returns the ORIGINAL invoice) and then re-added every item
 *  that had already landed on it. The merchant's invoice doubles the lines it
 *  got through before the failure. That is the duplicate-charge path, and it is
 *  reachable the first time the loop is longer than one item and Stripe blips.
 *
 *  Legacy's per-item pattern is restored here, widened for Foxhound's grain:
 *  legacy billed ONE aggregate recovery line per (account, period, currency),
 *  Foxhound bills one line PER RECOVERY, so the recovery id joins the key.
 *  Dispute lines key on the dispute id alone, exactly as legacy did, because a
 *  dispute is billed once ever regardless of which period sweeps it up. */
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

/** The Stripe key for one committed billing_line_items row. The first charge
 *  (run.ts) and every retry (charge-retry.ts) both derive it here, so they can
 *  never disagree. A fee line keys on its evidence, as above. A line with no
 *  evidence FK keys on its own row id: a shared fallback (the line type, or an
 *  empty dispute id) would hand two lines one key, and Stripe would return the
 *  first line's item for the second, which drops a line or attaches it to
 *  another merchant's invoice. */
export function lineItemIdempotencyKey(
  row: { id: string; type: string; recoveredPaymentId: string | null; disputeId: string | null },
  ctx: { accountId: string; periodKey: string; currency: string },
): string {
  if (row.type === "recovery_fee" && row.recoveredPaymentId) {
    return recoveryFeeItemIdempotencyKey(ctx.accountId, ctx.periodKey, ctx.currency, row.recoveredPaymentId);
  }
  if (row.type === "dispute_fee" && row.disputeId) return disputeFeeItemIdempotencyKey(row.disputeId);
  return `line_item_${row.id}`;
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

/**
 * Find an already-created platform invoice for one of our billing_invoices rows,
 * by the metadata createPlatformInvoice stamps on it. Returns null when Stripe
 * has none.
 *
 * This exists because Stripe idempotency keys EXPIRE AFTER 24 HOURS and the
 * charge-retry sweep runs monthly. Replaying platformInvoiceIdempotencyKey a
 * month later does not return the original invoice, it creates a second one, so
 * for the review-findings scenario-2 stranding (Stripe charged, our follow-up
 * ref-update write failed, our row still says draft with no stripe_invoice_id)
 * a key-only retry would double-charge the merchant. This lookup is what makes
 * the sweep safe at any age, and it also self-heals that scenario rather than
 * merely avoiding it: the invoice is adopted and the missing ref written.
 *
 * CONSISTENCY DEPENDENCY (review INFO-1). invoices.search is an INDEXED query and
 * is eventually consistent: a just-created invoice can be missing from it for a
 * short window. The whole no-double-charge property rests on this one call, and
 * it holds today only because the sweep runs monthly, so anything it looks up is
 * roughly a month old and long since indexed. Shortening the sweep interval, or
 * calling retryInvoiceCharge soon after a create, silently weakens the guard back
 * toward the double charge it exists to prevent. If that becomes necessary,
 * persist the Stripe invoice id at creation time and look it up directly instead
 * of searching.
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
 * paid, so the retry sweep has to finalize before it can collect (review
 * MEDIUM-1). Reuses createPlatformInvoice's finalize key, so a retry inside the
 * 24h idempotency window is the same call rather than a second one.
 */
export async function finalizePlatformInvoice(
  env: Env,
  stripeInvoiceId: string,
  billingInvoiceId: string,
): Promise<Stripe.Invoice> {
  const stripe = getStripe(env);
  return stripe.invoices.finalizeInvoice(stripeInvoiceId, undefined, {
    idempotencyKey: platformInvoiceFinalizeIdempotencyKey(billingInvoiceId),
  });
}

/** Attempt collection on an existing platform invoice. Separate from creation
 *  because Stripe does not auto-retry a one-off charge_automatically invoice. */
export async function payPlatformInvoice(
  env: Env,
  stripeInvoiceId: string,
  attemptNumber: number,
): Promise<Stripe.Invoice> {
  const stripe = getStripe(env);
  return stripe.invoices.pay(
    stripeInvoiceId,
    {},
    // Per-ATTEMPT key: two different attempts must really be two attempts, but a
    // redelivered/duplicated single attempt must not double-charge.
    { idempotencyKey: `platform-invoice-pay:${stripeInvoiceId}:${attemptNumber}` },
  );
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

/** Deterministic key for the credit note that reverses ONE fee line. Derived
 *  from the line's own id, so a redelivered refund replays the same key and
 *  Stripe returns the original note instead of issuing a second one. */
export function creditNoteIdempotencyKey(lineItemId: string): string {
  return `credit-note:${lineItemId}`;
}

export interface CreditNoteInput {
  /** The Stripe invoice the fee was charged on. */
  stripeInvoiceId: string;
  /** Minor units to credit, equal to the fee line being reversed. */
  amountCents: number;
  /** Our billing_line_items.id for the fee, for the key and for reconciliation. */
  feeLineItemId: string;
  memo: string;
}

/**
 * Credit a fee line back on the platform invoice it was charged on
 * (ruling 377(5), PRICING.md rev 5 item 1).
 *
 * `credit_amount` is Stripe's "apply this to the customer's balance" mode, as
 * opposed to `refund_amount`, which moves cash. That is the whole point of the
 * ruling: Stripe holds the credit against the customer in THAT currency and
 * draws it down on their next finalized invoice, so no money leaves and no
 * card is touched. A cash refund is Dustin's call and is not this path.
 *
 * THE INVOICE IS READ FIRST, because the idempotency key is not enough on a
 * retry. Stripe prunes v1 keys once they are at least 24 hours old and treats a
 * reused key after that as a new request, and the credit-note retry sweep runs
 * daily. If an earlier attempt's note landed but its ledger row did not, the
 * key alone would issue a second note. The note's own `fee_line_item_id`
 * metadata is what finds it instead. A note someone VOIDED is refused rather
 * than reissued: voiding is a person's decision, so the fee stays owed and the
 * sweep's alert puts it in front of one.
 */
export async function createCreditNote(
  env: Env,
  input: CreditNoteInput,
): Promise<{ creditNoteId: string }> {
  const stripe = getStripe(env);
  for await (const existing of stripe.creditNotes.list({ invoice: input.stripeInvoiceId, limit: 100 })) {
    if (existing.metadata?.fee_line_item_id !== input.feeLineItemId) continue;
    if (existing.status === "void") {
      throw new Error(`credit note ${existing.id} for fee line ${input.feeLineItemId} was voided at Stripe`);
    }
    return { creditNoteId: existing.id };
  }
  const note = await stripe.creditNotes.create(
    {
      invoice: input.stripeInvoiceId,
      credit_amount: input.amountCents,
      memo: input.memo,
      metadata: { fee_line_item_id: input.feeLineItemId },
    },
    { idempotencyKey: creditNoteIdempotencyKey(input.feeLineItemId) },
  );
  if (!note.id) throw new Error("stripe credit note create returned no id");
  return { creditNoteId: note.id };
}
