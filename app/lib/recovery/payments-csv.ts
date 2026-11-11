import type { FailedPaymentRow } from "./queries.server";
import { toCsv } from "@dustinedwards/site-runtime/csv";
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
// case. Status and Decline Category are the stored column values (active, failed_unrecovered, soft),
// as Recova writes them; the badges on the page keep their words, which
// APPROVED-DIFFERENCES 2026-08-14 covers, and the export is not a badge.
// Every Recova value has a Foxhound value of the same name, so nothing is
// mapped. Foxhound's stripe_retrying, revoked and unknown have no Recova
// twin and are written as stored too. The file itself is site-runtime's CSV
// (RFC 4180, CRLF after every record, the formula guard on), as every
// network export is, not Recova's LF with no final line break.

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

/** Build the full CSV text (header + one row per payment) for a set of
 *  already-filtered failed payments. A payment missing from `stepCounts` has
 *  no steps. */
export function buildPaymentsCsv(
  payments: FailedPaymentRow[],
  stepCounts: ReadonlyMap<string, PaymentStepCounts> = new Map(),
): string {
  return toCsv(
    CSV_HEADER,
    payments.map((p) => {
      const steps = stepCounts.get(p.id) ?? { executed: 0, total: 0 };
      return [
        p.customerName ?? "",
        p.customerEmail,
        p.planName ?? "",
        // A plain number, so the formula guard leaves it a number.
        moneyInputValue(p.amountCents, p.currency),
        p.currency.toUpperCase(),
        p.declineCategory,
        p.declineCode ?? "",
        p.status,
        steps.executed,
        steps.total,
        p.detectedAt,
        p.resolvedAt ?? "",
        p.notes ?? "",
      ];
    }),
  );
}
