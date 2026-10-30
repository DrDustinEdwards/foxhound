import { and, eq, isNotNull, isNull, notExists, notLike, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices, billingLineItems, disputes, getDb, recoveredPayments } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";

import { createCreditNote, creditNoteIdempotencyKey } from "./stripe-invoice";

// POST-BILLING CLAWBACK (ruling 377(5), PRICING.md rev 5 item 1, reversing rev
// 2's "no automatic credit after billing").
//
// Rev 2 replaced credit notes with maturity-window billing and was RIGHT about
// refunds: a recovery is not billed until it is 30 to 60 days settled, and the
// billable predicate excludes anything stamped refunded or disputed at run
// time, so the ordinary refund never reaches an invoice at all. That is why the
// "refund before the invoice" case below credits NOTHING and is a control
// rather than a gap.
//
// It was wrong about chargebacks. A dispute can land roughly 120 days out, long
// after the fee was invoiced and charged, and at that point maturity has
// already done all it can. Foxhound kept 20% of money the merchant no longer
// has, and the only lever was a manual adjustment nobody was going to remember
// to pull.
//
// WHAT THIS DOES NOT DO: move cash. `credit_amount` puts the money on the
// merchant's Stripe balance in that currency, and Stripe draws it down on their
// next finalized invoice. A cash refund is Dustin's call, only when no future
// invoice is expected, and is not built here.
//
// createAdjustment REMAINS THE INTERNAL MIRROR AND IS NOT THIS PATH. It writes
// its own standalone invoice, never touches Stripe, and requires an
// admin_audit_log row, all of which are right for discretionary goodwill and
// wrong for an automatic reversal driven by a Stripe event.

/** A fee line that has been charged and can still be credited. */
export interface CreditableFeeLine {
  lineItemId: string;
  invoiceId: string;
  accountId: string;
  currency: string;
  amountCents: number;
  stripeInvoiceId: string;
  recoveredPaymentId: string | null;
  disputeId: string | null;
}

export type CreditEvidence =
  | { recoveredPaymentId: string }
  | { disputeId: string };

/**
 * The invoiced fee line for one piece of evidence, when there is one to credit.
 *
 * Returns null in three distinct situations, and all three are correct:
 * no fee line exists (the recovery was never billable); a fee line exists but
 * its invoice never reached Stripe, so there is nothing to credit against and
 * the ordinary billable predicate will simply not bill it; or a credit already
 * exists for that line.
 *
 * The `stripe_invoice_id is not null` test is what "already on a finalized
 * platform invoice" means in this schema: it is written only after
 * createPlatformInvoice returns, so its presence is the evidence that Stripe
 * has the invoice.
 */
export async function findCreditableFeeLine(
  env: Env,
  evidence: CreditEvidence,
): Promise<CreditableFeeLine | null> {
  const db = getDb(env);
  const evidenceMatch =
    "recoveredPaymentId" in evidence
      ? and(
          eq(billingLineItems.recoveredPaymentId, evidence.recoveredPaymentId),
          eq(billingLineItems.type, "recovery_fee"),
        )
      : and(
          eq(billingLineItems.disputeId, evidence.disputeId),
          eq(billingLineItems.type, "dispute_fee"),
        );

  const rows = await db
    .select({
      lineItemId: billingLineItems.id,
      invoiceId: billingLineItems.invoiceId,
      accountId: billingLineItems.accountId,
      currency: billingLineItems.currency,
      amountCents: billingLineItems.amountCents,
      stripeInvoiceId: billingInvoices.stripeInvoiceId,
      recoveredPaymentId: billingLineItems.recoveredPaymentId,
      disputeId: billingLineItems.disputeId,
    })
    .from(billingLineItems)
    .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
    .where(and(evidenceMatch, isNotNull(billingInvoices.stripeInvoiceId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Already credited. The unique index would refuse a second row anyway; this
  // read is what turns that refusal into a quiet no-op instead of a rolled-back
  // batch and a redundant Stripe call.
  const existing = await db
    .select({ id: billingLineItems.id })
    .from(billingLineItems)
    .where(eq(billingLineItems.creditsLineItemId, row.lineItemId))
    .limit(1);
  if (existing.length > 0) return null;

  // Non-null by the WHERE above, which is the SINGLE authority on "has this
  // reached Stripe". An earlier version also re-checked the column here, and a
  // plant proved the pair useless: removing either left the other covering it,
  // so neither could be shown to fail on its own.
  return { ...row, stripeInvoiceId: row.stripeInvoiceId as string };
}

interface CreditLineInput {
  creditLineItemId: string;
  line: CreditableFeeLine;
  stripeCreditNoteId: string;
  description: string;
  createdAt: Date;
}

/**
 * The credit line, written against the SAME invoice the fee is on and carrying
 * the SAME evidence FK.
 *
 * NEGATIVE minor units, matching how `adjustment` already signs a credit. The
 * invoice's own `total_cents` is deliberately NOT recomputed: that number is
 * what the merchant was invoiced and what Stripe finalized, and a credit note
 * does not rewrite history, it offsets it. Stripe models it the same way.
 *
 * The insert is guarded by `billing_line_items_credits_line_uq`, so two racing
 * refund events cannot both land: the second violates the index and its whole
 * money batch rolls back to applied=false.
 */
function buildCreditLineBatch(db: Db, input: CreditLineInput): MoneyWriteBatch {
  return [
    db.insert(billingLineItems).values({
      id: input.creditLineItemId,
      invoiceId: input.line.invoiceId,
      accountId: input.line.accountId,
      type: "credit",
      currency: input.line.currency,
      amountCents: -Math.abs(input.line.amountCents),
      feeCents: null,
      recoveredPaymentId: input.line.recoveredPaymentId,
      disputeId: input.line.disputeId,
      description: input.description,
      createdAt: input.createdAt,
      stripeCreditNoteId: input.stripeCreditNoteId,
      creditsLineItemId: input.line.lineItemId,
    }),
  ];
}

export interface CreditNoteOutcome {
  credited: boolean;
  reason: string;
  creditNoteId?: string;
}

/**
 * Issue the credit note for one piece of evidence, if there is a charged fee to
 * reverse. Safe to call on every refund and every lost dispute: the common case
 * is that nothing was ever invoiced and this is two reads and a null.
 *
 * It never throws into the caller. The refund stamp and the dispute resolution
 * have already committed by the time this runs, and a Stripe outage must not
 * unwind a ledger fact that is true. A failure here is not lost either: the
 * fee is still owed by the ledger's own facts, and creditOwedFeeLines (the
 * daily credit-note-retry cron) finds it and tries again.
 */
export async function issueCreditNoteForEvidence(
  env: Env,
  evidence: CreditEvidence,
  opts: { now: Date; description: string },
): Promise<CreditNoteOutcome> {
  try {
    const line = await findCreditableFeeLine(env, evidence);
    if (!line) return { credited: false, reason: "no_charged_fee_line" };
    return await creditFeeLine(env, line, opts);
  } catch (err) {
    // Recorded, never rethrown: see the note above about not unwinding a
    // committed ledger fact.
    console.error(
      "credit note failed for",
      "recoveredPaymentId" in evidence ? evidence.recoveredPaymentId : evidence.disputeId,
      err instanceof Error ? err.message : err,
    );
    return { credited: false, reason: "credit_note_failed" };
  }
}

/**
 * Credit one charged fee line: the Stripe note, then the ledger row.
 *
 * ORDER: STRIPE FIRST, THEN THE LEDGER, and it is deliberate rather than
 * incidental. A ledger row written before the note would claim a credit the
 * merchant does not have if the Stripe call then failed, which is the worse of
 * the two failures: they would see the credit and never receive it. This way a
 * failure between the two leaves the note issued and the row missing, the
 * retry finds that same note on the invoice (createCreditNote), and the unique
 * index refuses a second row.
 */
async function creditFeeLine(
  env: Env,
  line: CreditableFeeLine,
  opts: { now: Date; description: string },
): Promise<CreditNoteOutcome> {
  const { creditNoteId } = await createCreditNote(env, {
    stripeInvoiceId: line.stripeInvoiceId,
    amountCents: Math.abs(line.amountCents),
    feeLineItemId: line.lineItemId,
    memo: opts.description,
  });

  const { applied } = await executeMoneyWrite(env, {
    accountId: line.accountId,
    // Keyed on the FEE LINE, not on the event: two different Stripe events
    // can both mean "this fee is owed back" (a refund and a later dispute on
    // the same payment), and keyed on the event they would each try to
    // credit it.
    idempotencyKey: creditNoteIdempotencyKey(line.lineItemId),
    build: (db) =>
      buildCreditLineBatch(db, {
        creditLineItemId: crypto.randomUUID(),
        line,
        stripeCreditNoteId: creditNoteId,
        description: opts.description,
        createdAt: opts.now,
      }),
  });

  return applied
    ? { credited: true, reason: "credited", creditNoteId }
    : { credited: false, reason: "already_credited", creditNoteId };
}

export const REFUND_CREDIT_DESCRIPTION = "Refunded recovery: fee credited";
export const DISPUTE_CREDIT_DESCRIPTION = "Dispute lost after billing: fee credited";
export const CHARGEBACK_CREDIT_DESCRIPTION = "Disputed recovery: fee credited";

/** Fee lines handled per sweep. Each costs a Stripe list and a create, so this
 *  keeps one run well inside a Worker's subrequest budget; anything past it is
 *  still owed tomorrow, and the run's message says so. */
const CREDIT_SWEEP_LIMIT = 50;

/**
 * Every charged fee line the ledger says is owed back and that has no credit
 * yet. THE OWED STATE IS DERIVED, NOT STORED: a recovery fee whose recovery is
 * stamped refunded or disputed, or a dispute fee whose dispute resolved lost, on an invoice
 * that reached Stripe, with no credit line pointing at it. Those are the same
 * facts the webhook path acts on, so a failed Stripe call, a Worker that died
 * between the stamp and the note, and a redelivery that skipped the clawback
 * all leave the line here until it is credited. No second table can drift from
 * the ledger, because there is no second table.
 */
async function findOwedFeeLines(
  env: Env,
  limit = CREDIT_SWEEP_LIMIT,
): Promise<(CreditableFeeLine & { disputedRecovery: boolean })[]> {
  const db = getDb(env);
  const credit = alias(billingLineItems, "credit");
  const rows = await db
    .select({
      lineItemId: billingLineItems.id,
      invoiceId: billingLineItems.invoiceId,
      accountId: billingLineItems.accountId,
      currency: billingLineItems.currency,
      amountCents: billingLineItems.amountCents,
      stripeInvoiceId: billingInvoices.stripeInvoiceId,
      recoveredPaymentId: billingLineItems.recoveredPaymentId,
      disputeId: billingLineItems.disputeId,
      recoveryRefundedAt: recoveredPayments.refundedAt,
    })
    .from(billingLineItems)
    .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
    .leftJoin(recoveredPayments, eq(recoveredPayments.id, billingLineItems.recoveredPaymentId))
    .leftJoin(disputes, eq(disputes.id, billingLineItems.disputeId))
    .where(
      and(
        isNotNull(billingInvoices.stripeInvoiceId),
        notLike(billingLineItems.accountId, `${DEMO_ACCOUNT_ID_PREFIX}%`),
        or(
          and(
            eq(billingLineItems.type, "recovery_fee"),
            // Refunded, or charged back: a dispute on the recovered payment
            // takes the money back just as a refund does, and its fee is
            // credited on the same fee-line key.
            or(isNotNull(recoveredPayments.refundedAt), isNotNull(recoveredPayments.disputedAt)),
            isNull(recoveredPayments.deletedAt),
          ),
          and(eq(billingLineItems.type, "dispute_fee"), eq(disputes.state, "resolved_lost")),
        ),
        notExists(
          db.select({ id: credit.id }).from(credit).where(eq(credit.creditsLineItemId, billingLineItems.id)),
        ),
      ),
    )
    .orderBy(billingLineItems.createdAt)
    .limit(limit);
  return rows.map(({ recoveryRefundedAt, ...row }) => ({
    ...row,
    stripeInvoiceId: row.stripeInvoiceId as string,
    disputedRecovery: row.recoveredPaymentId != null && recoveryRefundedAt == null,
  }));
}

export interface CreditSweepResult {
  credited: number;
  failed: { lineItemId: string; error: string }[];
  /** True when the sweep hit CREDIT_SWEEP_LIMIT, so more may still be owed. */
  full: boolean;
}

/** The credit-note retry sweep: credit every owed fee line it finds, one at a
 *  time, recording each failure rather than stopping on it. */
export async function creditOwedFeeLines(env: Env, now: Date): Promise<CreditSweepResult> {
  const owed = await findOwedFeeLines(env);
  const result: CreditSweepResult = { credited: 0, failed: [], full: owed.length === CREDIT_SWEEP_LIMIT };
  for (const line of owed) {
    try {
      const description = line.disputeId
        ? DISPUTE_CREDIT_DESCRIPTION
        : line.disputedRecovery
          ? CHARGEBACK_CREDIT_DESCRIPTION
          : REFUND_CREDIT_DESCRIPTION;
      const outcome = await creditFeeLine(env, line, { now, description });
      if (outcome.credited) result.credited += 1;
    } catch (err) {
      result.failed.push({ lineItemId: line.lineItemId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export function describeCreditSweep(result: CreditSweepResult): string {
  const more = result.full ? `, limit ${CREDIT_SWEEP_LIMIT} reached (more may be owed)` : "";
  return `${result.credited} credited, ${result.failed.length} failed${more}`;
}

/** The alert text when any owed fee could not be credited, or null. */
export function creditSweepFailureError(result: CreditSweepResult): string | null {
  if (result.failed.length === 0) return null;
  const detail = result.failed.map((f) => `${f.lineItemId}: ${f.error}`).join("; ");
  return `${result.failed.length} fee credit note(s) still owed after retry: ${detail}`;
}

/** Every recovery stamped disputed for one failed payment, the chargeback twin
 *  of refundedRecoveryIdsFor. */
export async function disputedRecoveryIdsFor(
  env: Env,
  failedPaymentId: string,
): Promise<string[]> {
  const db = getDb(env);
  const rows = await db
    .select({ id: recoveredPayments.id })
    .from(recoveredPayments)
    .where(
      and(
        eq(recoveredPayments.failedPaymentId, failedPaymentId),
        isNotNull(recoveredPayments.disputedAt),
        isNull(recoveredPayments.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Every recovery stamped refunded for one failed payment. The refund stamp is
 *  per failed payment; the fee lines hang off the recoveries under it. */
export async function refundedRecoveryIdsFor(
  env: Env,
  failedPaymentId: string,
): Promise<string[]> {
  const db = getDb(env);
  const rows = await db
    .select({ id: recoveredPayments.id })
    .from(recoveredPayments)
    .where(
      and(
        eq(recoveredPayments.failedPaymentId, failedPaymentId),
        isNotNull(recoveredPayments.refundedAt),
        isNull(recoveredPayments.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}
