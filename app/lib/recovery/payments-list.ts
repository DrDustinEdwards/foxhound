import { formatCurrencyTotalsShort } from "~/lib/dashboard/console";

// /recovery/payments (row S6, job J75): the page's pure, client-safe pieces.
// The route component imports these, so nothing here may import a .server
// module (RULES.md 4.5).

/** Recova's rows-per-page choices and its default, lib/payments-data.ts
 *  (VALID_PER_PAGE, DEFAULT_PER_PAGE = 25). */
export const PAYMENTS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, "all"] as const;
export type PaymentsPageSize = (typeof PAYMENTS_PAGE_SIZE_OPTIONS)[number];
export const PAYMENTS_DEFAULT_PAGE_SIZE: PaymentsPageSize = 25;

/** The page size in the URL ("perPage"), or Recova's default when it is not
 *  one of Recova's choices. Shared by the list and its CSV export. */
export function parsePaymentsPageSize(value: string | null): PaymentsPageSize {
  if (value === "all") return "all";
  const n = Number(value);
  return (PAYMENTS_PAGE_SIZE_OPTIONS as readonly (number | "all")[]).includes(n)
    ? (n as PaymentsPageSize)
    : PAYMENTS_DEFAULT_PAGE_SIZE;
}

/** The page number in the URL ("page"), 1 when absent or not a whole page. */
export function parsePaymentsPage(value: string | null): number {
  const n = Number(value ?? "1");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** Recova's amount slider moves in $10 steps (AmountRangeSlider.tsx STEP). */
export const AMOUNT_SLIDER_STEP_CENTS = 1000;

/** Recova's decline words: its filter options and its row pill, which renders
 *  the category under CSS capitalize. Foxhound's two extra categories take
 *  the same treatment. */
export const DECLINE_CATEGORY_WORDS: Record<string, string> = {
  soft: "Soft",
  network: "Network",
  expired: "Expired",
  fraud: "Fraud",
  revoked: "Revoked",
  unknown: "Unknown",
};

export function declineWord(category: string): string {
  return DECLINE_CATEGORY_WORDS[category] ?? category;
}

/** Recova's slider figures: whole dollars with no separator, and the top end
 *  as "$N+" (AmountRangeSlider.tsx formatDollars). */
export function sliderDollars(cents: number, isMax = false, absoluteMax = 0): string {
  if (isMax && cents >= absoluteMax) return `$${Math.round(absoluteMax / 100)}+`;
  return `$${Math.round(cents / 100)}`;
}

/** The head's figures, totaled per currency over the rows on screen, as
 *  Recova's PaymentsClient totals its `filtered` rows. */
export interface PaymentsHeaderStats {
  atRisk: { currency: string; cents: number }[];
  recovered: { currency: string; cents: number }[];
  ratePct: number;
}

/** Recova's PaymentsHeader line: "$X at risk · $Y recovered", then the rate
 *  only when it is above zero. Whole units, each currency on its own. */
export function paymentsHeaderLine(stats: PaymentsHeaderStats): string {
  const rate = stats.ratePct > 0 ? ` · ${stats.ratePct}% recovery rate` : "";
  return `${formatCurrencyTotalsShort(stats.atRisk)} at risk · ${formatCurrencyTotalsShort(stats.recovered)} recovered${rate}`;
}

/** Recova's pager line, PaymentsTable.tsx: "Showing 1–25 of 60 payments".
 *  With All chosen Recova's page size is the total, so it reads 1 to total. */
export function paymentsShowingText(page: number, pageSize: number | "all", total: number): string {
  const size = pageSize === "all" ? total : pageSize;
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  return `Showing ${from}–${to} of ${total} payments`;
}

/** Recova clears the bulk result 3 seconds after it lands (PaymentsClient.tsx
 *  doBulkAction: setTimeout(..., 3000)). */
export const BULK_RESULT_DISMISS_MS = 3000;

/** Whether the bulk result clears itself after BULK_RESULT_DISMISS_MS. Only
 *  when every payment took the action: a report with a failure, or a refused
 *  submission, stays until the merchant dismisses it, since a failure list
 *  that vanishes on a timer fails WCAG 2.2.1 (Timing Adjustable). Pending
 *  Dustin's ruling (J75 review). */
export function bulkResultClearsItself(
  bulk: { results?: readonly { ok: boolean }[]; refused?: unknown } | null | undefined,
): boolean {
  if (!bulk || bulk.refused !== undefined || !bulk.results) return false;
  return bulk.results.every((r) => r.ok);
}

/** Recova's bulk result line, PaymentsClient.tsx doBulkAction: the action's
 *  past tense, how many succeeded, and how many failed when any did. */
const BULK_RESULT_LABELS: Record<string, string> = {
  trigger: "Triggered",
  mark_recovered: "Marked recovered",
  cancel: "Canceled",
};

export function bulkResultLine(intent: string, results: readonly { ok: boolean }[]): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const label = BULK_RESULT_LABELS[intent] ?? intent;
  return `${label}: ${ok} succeeded${failed > 0 ? `, ${failed} failed` : ""}`;
}
