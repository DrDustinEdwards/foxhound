import { disputeFeeCents } from "~/lib/billing/fees";
import { BILLING_INVOICE_STATUS_LABELS, billingInvoiceStatusTone } from "~/lib/billing/labels";
import {
  formatInvoiceDate,
  type DisputeFeeRow,
  type FeeStatusTone,
  type RecoveryHistoryRow,
} from "~/lib/billing/page";
import { type PendingDisputeFee } from "~/lib/billing/preview.server";
import { groupSumByCurrency } from "~/lib/money/totals";
import type { BillingInvoiceRow, EnrichedLineItem } from "~/lib/billing/queries.server";

// The rows of /billing's Recovery and Dispute Fees sections, built from what
// the billing engine already stored. Read-only and computes no fee: every
// amount is a stored line item, a stored recovery or dispute, or a fee the
// preview took from fees.ts.

export const BILLING_HISTORY_LIMIT = 12;

/**
 * The credit notes issued against each fee line, summed as a positive amount,
 * keyed by the fee line they reverse (billing_line_items.credits_line_item_id,
 * written by credit-note.ts). Stored lines only; nothing is recomputed.
 */
function creditsByFeeLine(lineItems: EnrichedLineItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { lineItem } of lineItems) {
    if (lineItem.type !== "credit" || !lineItem.creditsLineItemId) continue;
    out.set(
      lineItem.creditsLineItemId,
      (out.get(lineItem.creditsLineItemId) ?? 0) + Math.abs(lineItem.amountCents),
    );
  }
  return out;
}

/**
 * No cap: what the percentage alone would charge, to tell whether the cap
 * bound.
 */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

function invoiceStatus(invoice: BillingInvoiceRow): {
  statusLabel: string;
  statusTone: FeeStatusTone;
} {
  const tone = billingInvoiceStatusTone(invoice.status);
  return {
    statusLabel: BILLING_INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status,
    statusTone: tone === "success" ? "ok" : tone === "failure" ? "crit" : "neutral",
  };
}

export function buildRecoveryHistory(
  invoices: BillingInvoiceRow[],
  lineItems: EnrichedLineItem[],
): RecoveryHistoryRow[] {
  const credits = creditsByFeeLine(lineItems);
  const rows: { periodStartMs: number; row: RecoveryHistoryRow }[] = [];
  for (const invoice of invoices) {
    const lines = lineItems.filter(
      (l) => l.lineItem.invoiceId === invoice.id && l.lineItem.type === "recovery_fee",
    );
    if (lines.length === 0) continue;
    const recovered = groupSumByCurrency(
      lines.map((l) => ({
        currency: l.recoveredPayment?.currency ?? l.lineItem.currency,
        cents: l.recoveredPayment?.amountCents ?? 0,
      })),
    );
    const fees = groupSumByCurrency(
      lines.map((l) => ({ currency: l.lineItem.currency, cents: l.lineItem.amountCents })),
    );
    rows.push({
      periodStartMs: invoice.periodStart.getTime(),
      row: {
        invoiceId: invoice.id,
        // Named by the run that issued it, not by its period: under maturity
        // most of an invoice's recoveries are from the month before its period,
        // so a month label would misdate them.
        periodLabel: `Invoiced ${formatInvoiceDate(invoice.createdAt.getTime())}`,
        currency: invoice.currency,
        recoveredCents: recovered.find((r) => r.currency === invoice.currency)?.cents ?? 0,
        feeCents: fees.find((f) => f.currency === invoice.currency)?.cents ?? 0,
        creditedCents: lines.reduce((sum, l) => sum + (credits.get(l.lineItem.id) ?? 0), 0),
        ...invoiceStatus(invoice),
        invoiceUrl: invoice.stripeInvoiceUrl,
        stripeInvoiceId: invoice.stripeInvoiceId,
      },
    });
  }
  return rows
    .sort((a, b) => b.periodStartMs - a.periodStartMs)
    .slice(0, BILLING_HISTORY_LIMIT)
    .map((r) => r.row);
}

export function buildDisputeFeeRows(
  invoices: BillingInvoiceRow[],
  lineItems: EnrichedLineItem[],
  pending: PendingDisputeFee[],
): DisputeFeeRow[] {
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const credits = creditsByFeeLine(lineItems);
  const capped = (amountCents: number, feeCents: number) =>
    feeCents < disputeFeeCents(amountCents, UNCAPPED);

  const pendingRows: DisputeFeeRow[] = [...pending]
    .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))
    .map((d) => ({
      key: `pending_${d.disputeId}`,
      disputeId: d.disputeId,
      currency: d.currency,
      disputeAmountCents: d.amountCents,
      feeCents: d.feeCents,
      feeCapped: capped(d.amountCents, d.feeCents),
      creditedCents: 0,
      statusLabel: "Pending",
      statusTone: "neutral",
      invoiceUrl: null,
      stripeInvoiceId: null,
    }));

  const billedRows: DisputeFeeRow[] = lineItems
    .filter((l) => l.lineItem.type === "dispute_fee" && l.dispute)
    .sort((a, b) => b.lineItem.createdAt.getTime() - a.lineItem.createdAt.getTime())
    .map(({ lineItem, dispute }) => {
      const invoice = invoiceById.get(lineItem.invoiceId);
      const amount = dispute!.amountCents;
      return {
        key: lineItem.id,
        disputeId: dispute!.id,
        currency: lineItem.currency,
        disputeAmountCents: amount,
        feeCents: lineItem.amountCents,
        feeCapped: capped(amount, lineItem.amountCents),
        creditedCents: credits.get(lineItem.id) ?? 0,
        ...(invoice
          ? invoiceStatus(invoice)
          : { statusLabel: "Pending", statusTone: "neutral" as const }),
        invoiceUrl: invoice?.stripeInvoiceUrl ?? null,
        stripeInvoiceId: invoice?.stripeInvoiceId ?? null,
      };
    });

  return [...pendingRows, ...billedRows].slice(0, BILLING_HISTORY_LIMIT);
}
