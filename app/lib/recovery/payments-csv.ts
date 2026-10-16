import type { FailedPaymentRow } from "./queries.server";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS } from "./labels";
import type { DeclineCategory } from "~/lib/constants";

// The /recovery/payments CSV export. Pure and unit-tested: given the rows
// listFilteredFailedPayments returns for the list's own filters, sort, page
// and page size, and the step counts for those rows, builds the exact file
// contents. That is the rows on screen, as Recova's Export CSV writes them
// (PaymentsClient.tsx handleExport, exportToCSV(filtered)); "All" as the page
// size is every matching row. The export route re-runs that query server
// side, scoped to the account.
//
// The columns and their order are Recova's own, read from lib/csv.ts
// PAYMENT_CSV_HEADERS and buildPaymentCsvRows: Steps Executed counts the
// payment's steps with an executed time, Total Steps counts all of them,
// dates are ISO 8601 and the currency is upper case. Status and decline
// category go through the same label tables as the list (Recova wrote the raw
// column values there; reported in the PR, not decided here).

const CSV_HEADER = [
  "Customer Name",
  "Email",
  "Plan",
  "Amount",
  "Currency",
  "Decline Category",
  "Decline Code",
  "Status",
  "Steps Executed",
  "Total Steps",
  "Detected At",
  "Resolved At",
  "Notes",
];

export interface PaymentStepCounts {
  executed: number;
  total: number;
}

/** A cell a spreadsheet would read as a formula (or as a formula after a
 *  leading tab or carriage return) gets a single quote in front, so it opens
 *  as text. Applied to every cell, whatever its column. */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Quote a field per RFC 4180 only when it needs it (contains a comma,
 *  quote, CR or LF); doubles any embedded quotes. */
function csvField(raw: string): string {
  const value = neutraliseFormula(raw);
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",");
}

/** Build the full CSV text (header + one row per payment) for a set of
 *  already-filtered failed payments. A payment missing from `stepCounts` has
 *  no steps. */
export function buildPaymentsCsv(
  payments: FailedPaymentRow[],
  stepCounts: ReadonlyMap<string, PaymentStepCounts> = new Map(),
): string {
  const lines = [csvRow(CSV_HEADER)];
  for (const p of payments) {
    const steps = stepCounts.get(p.id) ?? { executed: 0, total: 0 };
    lines.push(
      csvRow([
        p.customerName ?? "",
        p.customerEmail,
        p.planName ?? "",
        (p.amountCents / 100).toFixed(2),
        p.currency.toUpperCase(),
        DECLINE_CATEGORY_LABELS[p.declineCategory as DeclineCategory] ?? p.declineCategory,
        p.declineCode ?? "",
        FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status,
        String(steps.executed),
        String(steps.total),
        p.detectedAt.toISOString(),
        p.resolvedAt ? p.resolvedAt.toISOString() : "",
        p.notes ?? "",
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
