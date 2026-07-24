import type { FailedPaymentRow } from "./queries.server";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS } from "./labels";
import type { DeclineCategory } from "~/lib/constants";

// The /recovery/payments CSV export (TASK-foxhound-recovery-surface-parity.md
// Phase 3). Pure and unit-tested: given the SAME filtered, unpaginated rows
// listFilteredFailedPayments(..., { pageSize: "all" }) would return, builds
// the exact file contents. No client-side filtering: the export route re-runs
// the current filters server-side rather than reusing whatever page happens
// to already be on screen.

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
