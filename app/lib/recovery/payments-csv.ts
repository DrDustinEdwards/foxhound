import type { FailedPaymentRow } from "./queries.server";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS } from "./labels";
import type { DeclineCategory } from "~/lib/constants";

// The /recovery/payments CSV export. Pure and unit-tested: given the rows
// listFilteredFailedPayments returns for the list's own filters, sort, page
// and page size, builds the exact file contents. That is the rows on screen,
// as Recova's Export CSV writes them (PaymentsClient.tsx handleExport,
// exportToCSV(filtered)); "All" as the page size is every matching row. The
// export route re-runs that query server side, scoped to the account.

const CSV_HEADER = ["Customer", "Email", "Plan", "Amount", "Currency", "Decline category", "Decline code", "Status", "Detected at"];

/** Quote a field per RFC 4180 only when it needs it (contains a comma,
 *  quote, or newline); doubles any embedded quotes. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",");
}

/** Build the full CSV text (header + one row per payment) for a set of
 *  already-filtered failed payments. */
export function buildPaymentsCsv(payments: FailedPaymentRow[]): string {
  const lines = [csvRow(CSV_HEADER)];
  for (const p of payments) {
    lines.push(
      csvRow([
        p.customerName ?? "",
        p.customerEmail,
        p.planName ?? "",
        (p.amountCents / 100).toFixed(2),
        p.currency,
        DECLINE_CATEGORY_LABELS[p.declineCategory as DeclineCategory] ?? p.declineCategory,
        p.declineCode ?? "",
        FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status,
        p.detectedAt.toISOString(),
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
