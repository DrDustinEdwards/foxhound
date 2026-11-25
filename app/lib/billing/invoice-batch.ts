import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { buildGuardedRecoveryLineInsert, buildInvoiceTotalFromLines } from "~/db/billable";
import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices, billingLineItems } from "~/db";

import { feeForCurrency, recoveryFeeCents, unrefundedCents } from "./fees";
import {
  disputeFeeItemIdempotencyKey,
  lineItemIdempotencyKey,
  recoveryFeeItemIdempotencyKey,
  type PlatformInvoiceLineInput,
} from "./stripe-invoice";

export interface BillableRecoveryLite {
  id: string;
  amountCents: number;
  /** Refunded so far; the fee is taken on the rest. */
  refundedCents: number;
}
export interface BillableDisputeLite {
  id: string;
  amountCents: number;
  /**
   * The cap-applied fee stored at resolution or by the pricing retry. An
   * unpriced win never reaches the run (billableDisputeRowConditions), and
   * there is no computed fallback: the fee billed is the fee the merchant was
   * told.
   */
  resolvedFeeCents: number;
}

export interface InvoiceBatchInput {
  invoiceId: string;
  accountId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /**
   * YYYY-MM of the period being billed. Part of each recovery line's Stripe
   * idempotency key, so the key is stable across retries of the same period
   * without depending on the run-scoped billing_invoices id.
   */
  periodKey: string;
  idempotencyKey: string;
  createdAt: Date;
  /**
   * The run's asOf, re-evaluated by the guarded line insert so the batch
   * applies the SAME maturity cutoff the billable read applied.
   */
  asOfMs: number;
  recoveries: BillableRecoveryLite[];
  disputes: BillableDisputeLite[];
}

export interface BuiltInvoiceBatch {
  batch: MoneyWriteBatch;
  totalCents: number;
  lineItemCount: number;
  /**
   * The plain line data, alongside the SQL batch, so the caller can hand it to
   * createPlatformInvoice after the write commits without a re-query.
   */
  lines: PlatformInvoiceLineInput[];
}

/** An invoice's committed line items, with the columns a Stripe line key is derived from. */
export function readInvoiceLineItems(db: Db, invoiceId: string) {
  return db
    .select({
      id: billingLineItems.id,
      type: billingLineItems.type,
      amountCents: billingLineItems.amountCents,
      description: billingLineItems.description,
      recoveredPaymentId: billingLineItems.recoveredPaymentId,
      disputeId: billingLineItems.disputeId,
    })
    .from(billingLineItems)
    .where(eq(billingLineItems.invoiceId, invoiceId));
}

/**
 * Re-read one invoice's committed line items and rebuild the Stripe input from
 * them. Used after the money batch commits, because a guarded line can decline
 * to insert itself and the pre-write list would then overstate the invoice.
 */
export async function readCommittedInvoice(
  db: Db,
  opts: { invoiceId: string; accountId: string; currency: string; periodKey: string },
): Promise<{ totalCents: number; lineItemCount: number; lines: PlatformInvoiceLineInput[] }> {
  const rows = await readInvoiceLineItems(db, opts.invoiceId);

  const lines: PlatformInvoiceLineInput[] = rows.map((row) => ({
    type: row.type,
    amountCents: row.amountCents,
    description: row.description ?? "",
    idempotencyKey: lineItemIdempotencyKey(row, opts),
  }));

  return {
    totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    lineItemCount: rows.length,
    lines,
  };
}

/**
 * Builds the atomic invoice batch (the billing_invoices row followed by its
 * billing_line_items). The invoice is first so the line items' FK resolves
 * inside the same transaction. Pure and unit-testable; the caller supplies the
 * invoice id so the linkage is deterministic.
 */
export function buildBillingInvoiceBatch(db: Db, input: InvoiceBatchInput): BuiltInvoiceBatch {
  const lineItems: BatchItem<"sqlite">[] = [];
  const lines: PlatformInvoiceLineInput[] = [];
  let total = 0;

  for (const r of input.recoveries) {
    const fee = feeForCurrency(
      recoveryFeeCents(unrefundedCents(r.amountCents, r.refundedCents)),
      input.currency,
    );
    // Refunded down to nothing chargeable: no line, as for a full refund.
    if (fee <= 0) continue;
    total += fee;
    // GUARDED: the predicate is re-evaluated by the database as this row is
    // written, inside the batch. A refund landing between the billable read and
    // this write selects zero rows and bills nothing; the next run bills what
    // is left.
    lineItems.push(
      buildGuardedRecoveryLineInsert(db, {
        lineItemId: crypto.randomUUID(),
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        currency: input.currency,
        recoveredPaymentId: r.id,
        feeCents: fee,
        refundedCents: r.refundedCents,
        description: "Recovery fee",
        createdAt: input.createdAt,
        asOfMs: input.asOfMs,
      }),
    );
    lines.push({
      type: "recovery_fee",
      amountCents: fee,
      description: "Recovery fee",
      idempotencyKey: recoveryFeeItemIdempotencyKey(
        input.accountId,
        input.periodKey,
        input.currency,
        r.id,
      ),
    });
  }

  for (const d of input.disputes) {
    const fee = d.resolvedFeeCents;
    total += fee;
    lineItems.push(
      db.insert(billingLineItems).values({
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        type: "dispute_fee",
        currency: input.currency,
        amountCents: fee,
        feeCents: fee,
        disputeId: d.id,
        description: "Dispute fee",
        createdAt: input.createdAt,
      }),
    );
    lines.push({
      type: "dispute_fee",
      amountCents: fee,
      description: "Dispute fee",
      idempotencyKey: disputeFeeItemIdempotencyKey(d.id),
    });
  }

  const invoiceInsert = db.insert(billingInvoices).values({
    id: input.invoiceId,
    accountId: input.accountId,
    currency: input.currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: "draft",
    totalCents: total,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
  });

  // The invoice row carries the JS total, then the last statement in the batch
  // replaces it with the sum of the lines that ACTUALLY landed. Without this a
  // withdrawn line would leave the invoice overstated by exactly its fee, which
  // is the same defect one level up.
  const batch: MoneyWriteBatch = [
    invoiceInsert,
    ...lineItems,
    buildInvoiceTotalFromLines(db, input.invoiceId),
  ];
  return { batch, totalCents: total, lineItemCount: lineItems.length, lines };
}
