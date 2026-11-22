import type { FailedPaymentRow } from "./queries.server";
import { toCsv } from "@dustinedwards/site-runtime/csv";
import { moneyInputValue } from "@dustinedwards/site-runtime/money";

// The /recovery/payments CSV export. The export route re-runs that query server side, scoped to the
// account.

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
