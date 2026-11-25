import { and, eq, exists, gt, isNotNull, isNull, notLike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices, billingLineItems, disputes, getDb, recoveredPayments } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";

import { feeForCurrency, recoveryFeeCents, unrefundedCents } from "./fees";
import { createCreditNote, creditNoteIdempotencyKey } from "./stripe-invoice";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// Rev 2 replaced credit notes with maturity-window billing and was RIGHT about
// refunds: a recovery is not billed until it is 30 to 60 days settled, and the
// billable predicate excludes anything stamped refunded or disputed at run
// time, so the ordinary refund never reaches an invoice at all. That is why the
// "refund before the invoice" case below credits NOTHING and is a control
// rather than a gap.

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
  /** What this line's credit should come to in all (owedCreditCents). */
  owedCents: number;
  /** What its credit line already says, 0 when it has none. */
  creditedCents: number;
  /** Its credit line, when there is one. */
  creditLineItemId: string | null;
  /**
   * recovery_fee only: the recovery's refunded_cents now, recorded on the fee
   * line once settled so the sweep stops finding it.
   */
  recoveryRefundedCents: number | null;
}

export type CreditEvidence = { recoveredPaymentId: string } | { disputeId: string };

/** The facts a fee line's owed credit is worked out from. */
interface CreditFacts {
  type: string;
  currency: string;
  feeCents: number;
  recoveryAmountCents: number | null;
  recoveryRefundedCents: number | null;
  recoveryRefundedAt: Date | null;
  recoveryDisputedAt: Date | null;
}

/**
 * What a charged fee line's credit should come to in all. Pure.
 *
 * A recovery fee is credited whole when the charge was fully refunded or
 * charged back, and otherwise by the refunded share: the fee as billed, less
 * the fee on what is still unrefunded. Never below 0 or above the fee.
 */
function owedCreditCents(facts: CreditFacts): number {
  if (facts.type !== "recovery_fee") return facts.feeCents;
  if (facts.recoveryRefundedAt || facts.recoveryDisputedAt) return facts.feeCents;
  const stillOwed = feeForCurrency(
    recoveryFeeCents(
      unrefundedCents(facts.recoveryAmountCents ?? 0, facts.recoveryRefundedCents ?? 0),
    ),
    facts.currency,
  );
  return Math.min(facts.feeCents, Math.max(0, facts.feeCents - stillOwed));
}

const credit = alias(billingLineItems, "credit");

/** The columns a creditable fee line is read with, in both lookups below. */
const FEE_LINE_FIELDS = {
  lineItemId: billingLineItems.id,
  invoiceId: billingLineItems.invoiceId,
  accountId: billingLineItems.accountId,
  type: billingLineItems.type,
  currency: billingLineItems.currency,
  amountCents: billingLineItems.amountCents,
  lineRefundedCents: billingLineItems.refundedCents,
  stripeInvoiceId: billingInvoices.stripeInvoiceId,
  recoveredPaymentId: billingLineItems.recoveredPaymentId,
  disputeId: billingLineItems.disputeId,
  creditLineItemId: credit.id,
  creditAmountCents: credit.amountCents,
  recoveryAmountCents: recoveredPayments.amountCents,
  recoveryRefundedCents: recoveredPayments.refundedCents,
  recoveryRefundedAt: recoveredPayments.refundedAt,
  recoveryDisputedAt: recoveredPayments.disputedAt,
};

type FeeLineRow = {
  lineItemId: string;
  invoiceId: string;
  accountId: string;
  type: string;
  currency: string;
  amountCents: number;
  lineRefundedCents: number;
  stripeInvoiceId: string | null;
  recoveredPaymentId: string | null;
  disputeId: string | null;
  creditLineItemId: string | null;
  creditAmountCents: number | null;
  recoveryAmountCents: number | null;
  recoveryRefundedCents: number | null;
  recoveryRefundedAt: Date | null;
  recoveryDisputedAt: Date | null;
};

/** A fee line read with FEE_LINE_FIELDS, with what it is owed worked out. */
function toCreditable(row: FeeLineRow): CreditableFeeLine {
  return {
    lineItemId: row.lineItemId,
    invoiceId: row.invoiceId,
    accountId: row.accountId,
    currency: row.currency,
    amountCents: row.amountCents,
    // Non-null: both lookups require it (the SINGLE authority on "has this
    // reached Stripe").
    stripeInvoiceId: row.stripeInvoiceId as string,
    recoveredPaymentId: row.recoveredPaymentId,
    disputeId: row.disputeId,
    owedCents: owedCreditCents({ ...row, feeCents: row.amountCents }),
    creditedCents: Math.abs(row.creditAmountCents ?? 0),
    creditLineItemId: row.creditLineItemId,
    recoveryRefundedCents: row.type === "recovery_fee" ? (row.recoveryRefundedCents ?? 0) : null,
  };
}

/** The fee lines with their credit and recovery, as both lookups read them. */
function feeLineQuery(db: Db) {
  return db
    .select(FEE_LINE_FIELDS)
    .from(billingLineItems)
    .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
    .leftJoin(credit, eq(credit.creditsLineItemId, billingLineItems.id))
    .leftJoin(recoveredPayments, eq(recoveredPayments.id, billingLineItems.recoveredPaymentId));
}

/**
 * The invoiced fee line for one piece of evidence, with what is owed on it.
 *
 * Returns null when no fee line exists (the recovery was never billable) or its
 * invoice never reached Stripe, so there is nothing to credit against and the
 * billing run's own predicate settles it instead.
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
  const rows = await feeLineQuery(getDb(env))
    .where(and(evidenceMatch, isNotNull(billingInvoices.stripeInvoiceId)))
    .limit(1);
  return rows[0] ? toCreditable(rows[0]) : null;
}

interface CreditLineInput {
  line: CreditableFeeLine;
  stripeCreditNoteId: string;
  description: string;
  createdAt: Date;
}

/**
 * The credit line, written against the SAME invoice the fee is on and carrying
 * the SAME evidence FK, for the line's owed total.
 *
 * The invoice's own `total_cents` is deliberately NOT recomputed: that number
 * is what the merchant was invoiced and what Stripe finalized, and a credit
 * note does not rewrite history, it offsets it. Stripe models it the same way.
 */
function buildCreditLineBatch(db: Db, input: CreditLineInput): MoneyWriteBatch {
  const { line } = input;
  const total = -line.owedCents;
  const creditWrite = line.creditLineItemId
    ? db
        .update(billingLineItems)
        .set({ amountCents: total, stripeCreditNoteId: input.stripeCreditNoteId })
        .where(
          and(
            eq(billingLineItems.id, line.creditLineItemId),
            eq(billingLineItems.amountCents, -line.creditedCents),
          ),
        )
    : db.insert(billingLineItems).values({
        id: crypto.randomUUID(),
        invoiceId: line.invoiceId,
        accountId: line.accountId,
        type: "credit",
        currency: line.currency,
        amountCents: total,
        feeCents: null,
        recoveredPaymentId: line.recoveredPaymentId,
        disputeId: line.disputeId,
        description: input.description,
        createdAt: input.createdAt,
        stripeCreditNoteId: input.stripeCreditNoteId,
        creditsLineItemId: line.lineItemId,
      });
  return [
    creditWrite,
    ...(line.recoveryRefundedCents === null
      ? []
      : [
          db
            .update(billingLineItems)
            .set({ refundedCents: line.recoveryRefundedCents })
            .where(
              and(
                eq(billingLineItems.id, line.lineItemId),
                exists(
                  db
                    .select({ id: credit.id })
                    .from(credit)
                    .where(
                      and(
                        eq(credit.creditsLineItemId, line.lineItemId),
                        eq(credit.amountCents, total),
                      ),
                    ),
                ),
              ),
            ),
        ]),
  ];
}

/**
 * A refund too small to move the fee (or none) still settles the fee line, so
 * the sweep stops finding it.
 */
function buildSettledMarker(db: Db, line: CreditableFeeLine): MoneyWriteBatch {
  return [
    db
      .update(billingLineItems)
      .set({ refundedCents: line.recoveryRefundedCents ?? 0 })
      .where(eq(billingLineItems.id, line.lineItemId)),
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
 * is that nothing was ever invoiced and this is one read and a null.
 *
 * It never throws into the caller. The refund stamp and the dispute resolution
 * have already committed by the time this runs, and a Stripe outage must not
 * unwind a ledger fact that is true.
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
      errorMessage(err),
    );
    return { credited: false, reason: "credit_note_failed" };
  }
}

/**
 * Bring one charged fee line's credit up to what it is owed: the Stripe note,
 * then the ledger row.
 *
 * ORDER: STRIPE FIRST, THEN THE LEDGER, and it is deliberate rather than
 * incidental. A ledger row written before the note would claim a credit the
 * merchant does not have if the Stripe call then failed, which is the worse of
 * the two failures: they would see the credit and never receive it.
 */
async function creditFeeLine(
  env: Env,
  line: CreditableFeeLine,
  opts: { now: Date; description: string },
): Promise<CreditNoteOutcome> {
  // Keyed on the FEE LINE and its total, not on the event: two different Stripe
  // events can both mean "this fee is owed back" (a refund and a later dispute
  // on the same payment), and keyed on the event they would each try to credit
  // it.
  const idempotencyKey = creditNoteIdempotencyKey(line.lineItemId, line.owedCents);
  if (line.owedCents <= line.creditedCents) {
    if (line.recoveryRefundedCents !== null) {
      await executeMoneyWrite(env, {
        accountId: line.accountId,
        idempotencyKey: `${idempotencyKey}:settled:${line.recoveryRefundedCents}`,
        build: (db) => buildSettledMarker(db, line),
      });
    }
    return { credited: false, reason: "nothing_owed" };
  }

  const { creditNoteId } = await createCreditNote(env, {
    stripeInvoiceId: line.stripeInvoiceId,
    creditedTotalCents: line.owedCents,
    feeLineItemId: line.lineItemId,
    memo: opts.description,
  });

  const { applied } = await executeMoneyWrite(env, {
    accountId: line.accountId,
    idempotencyKey,
    build: (db) =>
      buildCreditLineBatch(db, {
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

/**
 * Fee lines handled per sweep. Each costs a Stripe list and a create, so this
 * keeps one run well inside a Worker's subrequest budget; anything past it is
 * still owed tomorrow, and the run's message says so.
 */
const CREDIT_SWEEP_LIMIT = 50;

/**
 * Every charged fee line the ledger says is owed a credit it does not have yet.
 * THE OWED STATE IS DERIVED, NOT STORED: a recovery fee whose recovery is
 * stamped refunded or disputed and is not yet credited in full, a recovery fee
 * whose recovery has been refunded more than the fee line accounts for, or a
 * dispute fee whose dispute resolved lost with no credit, on an invoice that
 * reached Stripe.
 */
async function findOwedFeeLines(
  env: Env,
  limit = CREDIT_SWEEP_LIMIT,
): Promise<(CreditableFeeLine & { disputedRecovery: boolean })[]> {
  const db = getDb(env);
  const rows = await feeLineQuery(db)
    .leftJoin(disputes, eq(disputes.id, billingLineItems.disputeId))
    .where(
      and(
        isNotNull(billingInvoices.stripeInvoiceId),
        notLike(billingLineItems.accountId, `${DEMO_ACCOUNT_ID_PREFIX}%`),
        or(
          and(
            eq(billingLineItems.type, "recovery_fee"),
            isNull(recoveredPayments.deletedAt),
            or(
              // Refunded in full, or charged back (a dispute on the recovered
              // payment takes the money back just as a refund does), and not
              // yet credited in full.
              and(
                or(
                  isNotNull(recoveredPayments.refundedAt),
                  isNotNull(recoveredPayments.disputedAt),
                ),
                or(
                  isNull(credit.id),
                  sql`${billingLineItems.amountCents} + ${credit.amountCents} > 0`,
                ),
              ),
              // Refunded more than the fee line accounts for.
              gt(recoveredPayments.refundedCents, billingLineItems.refundedCents),
            ),
          ),
          and(
            eq(billingLineItems.type, "dispute_fee"),
            eq(disputes.state, "resolved_lost"),
            isNull(credit.id),
          ),
        ),
      ),
    )
    .orderBy(billingLineItems.createdAt)
    .limit(limit);
  return rows.map((row) => ({
    ...toCreditable(row),
    disputedRecovery: row.recoveryDisputedAt != null && row.recoveryRefundedAt == null,
  }));
}

export interface CreditSweepResult {
  credited: number;
  failed: { lineItemId: string; error: string }[];
  /** True when the sweep hit CREDIT_SWEEP_LIMIT, so more may still be owed. */
  full: boolean;
}

/**
 * The credit-note retry sweep: credit every owed fee line it finds, one at a
 * time, recording each failure rather than stopping on it.
 */
export async function creditOwedFeeLines(env: Env, now: Date): Promise<CreditSweepResult> {
  const owed = await findOwedFeeLines(env);
  const result: CreditSweepResult = {
    credited: 0,
    failed: [],
    full: owed.length === CREDIT_SWEEP_LIMIT,
  };
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
      result.failed.push({
        lineItemId: line.lineItemId,
        error: errorMessage(err),
      });
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
