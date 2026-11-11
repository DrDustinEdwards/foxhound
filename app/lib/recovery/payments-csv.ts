import type { FailedPaymentRow } from "./queries.server";
import { csvRow } from "@dustinedwards/site-runtime/csv";
import { moneyInputValue } from "@dustinedwards/site-runtime/money";

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

// Each record is site-runtime ./csv csvRow: RFC 4180 quoting and the OWASP
// formula guard on every text cell (name, email, plan, currency, decline
// category and code, status, notes), since a customer, a merchant or Stripe
// controls those. A cell that is only a number (an amount such as -5.00, a
// step count) is left as itself, so it stays a number in the spreadsheet.
// Recova had no guard.

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
        moneyInputValue(p.amountCents, p.currency),
        p.currency.toUpperCase(),
        p.declineCategory,
        p.declineCode ?? "",
        p.status,
        steps.executed,
        steps.total,
        p.detectedAt.toISOString(),
        p.resolvedAt ? p.resolvedAt.toISOString() : "",
        p.notes ?? "",
      ]),
    );
  }
  return lines.join("\n");
}
