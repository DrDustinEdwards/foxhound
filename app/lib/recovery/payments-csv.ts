import type { FailedPaymentRow } from "./queries.server";

// The /recovery/payments CSV export. Pure and unit-tested: given the rows
// listFilteredFailedPayments returns for the list's own filters, sort, page
// and page size, and the step counts for those rows, builds the exact file
// contents. That is the rows on screen, as Recova's Export CSV writes them
// (PaymentsClient.tsx handleExport, exportToCSV(filtered)); "All" as the page
// size is every matching row. The export route re-runs that query server
// side, scoped to the account.
//
// The file's form is Recova's own, read from lib/csv.ts PAYMENT_CSV_HEADERS,
// buildPaymentCsvRows and paymentRowsToCsv: the same 13 columns in the same
// order, Steps Executed counts the payment's steps with an executed time,
// Total Steps counts all of them, dates are ISO 8601, the currency is upper
// case, lines end in LF and there is no final line break. Status and Decline
// Category are the stored column values (active, failed_unrecovered, soft),
// as Recova writes them; the badges on the page keep their words, which
// APPROVED-DIFFERENCES 2026-08-14 covers, and the export is not a badge.
// Every Recova value has a Foxhound value of the same name, so nothing is
// mapped. Foxhound's stripe_retrying, revoked and unknown have no Recova
// twin and are written as stored too.

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
 *  as text. Recova has no such guard; it is kept on every free-text cell
 *  (name, email, plan, currency, decline category and code, status, notes),
 *  since a customer, a merchant or Stripe controls those. */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The only cells exempt from the guard: values this module produces itself,
 *  and only while they match the strict shape it produces. An amount such as
 *  -5.00 then stays a number in the spreadsheet instead of becoming text. */
const AMOUNT_PATTERN = /^-?\d+\.\d{2}$/;
const COUNT_PATTERN = /^\d+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Cell = { text: string } | { produced: string; pattern: RegExp };

/** Quote a field per RFC 4180 only when it needs it (contains a comma,
 *  quote, CR or LF); doubles any embedded quotes. */
function csvField(cell: Cell): string {
  const value =
    "text" in cell
      ? neutraliseFormula(cell.text)
      : cell.pattern.test(cell.produced)
        ? cell.produced
        : neutraliseFormula(cell.produced);
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(cells: Cell[]): string {
  return cells.map(csvField).join(",");
}

const text = (value: string): Cell => ({ text: value });
const produced = (value: string, pattern: RegExp): Cell => (value === "" ? { text: "" } : { produced: value, pattern });

/** Build the full CSV text (header + one row per payment) for a set of
 *  already-filtered failed payments. A payment missing from `stepCounts` has
 *  no steps. */
export function buildPaymentsCsv(
  payments: FailedPaymentRow[],
  stepCounts: ReadonlyMap<string, PaymentStepCounts> = new Map(),
): string {
  const lines = [csvRow(CSV_HEADER.map(text))];
  for (const p of payments) {
    const steps = stepCounts.get(p.id) ?? { executed: 0, total: 0 };
    lines.push(
      csvRow([
        text(p.customerName ?? ""),
        text(p.customerEmail),
        text(p.planName ?? ""),
        produced((p.amountCents / 100).toFixed(2), AMOUNT_PATTERN),
        text(p.currency.toUpperCase()),
        text(p.declineCategory),
        text(p.declineCode ?? ""),
        text(p.status),
        produced(String(steps.executed), COUNT_PATTERN),
        produced(String(steps.total), COUNT_PATTERN),
        produced(p.detectedAt.toISOString(), ISO_DATE_PATTERN),
        produced(p.resolvedAt ? p.resolvedAt.toISOString() : "", ISO_DATE_PATTERN),
        text(p.notes ?? ""),
      ]),
    );
  }
  return lines.join("\n");
}
