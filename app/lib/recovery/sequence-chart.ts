import { EMAIL_ENGAGEMENT_WINDOW_DAYS } from "~/lib/constants";

import type { StepPerformancePoint } from "./sequence-performance";

// The step performance chart's data and text equivalent, drawn by
// Enarratio on /recovery/sequence in place of Recova's Recharts BarChart
// (StepPerformanceChart.tsx edf8f83c). Pure, so the route draws and the tests
// read the same rows.

/** Recova's series, in its funnel order: each depends on the one before. */
export const STEP_PERFORMANCE_SERIES = ["Open rate", "Click rate", "Recovery rate"] as const;

export interface StepPerformanceRow {
  Step: string;
  series: (typeof STEP_PERFORMANCE_SERIES)[number];
  rate: number;
}

export function stepPerformanceRows(chart: readonly StepPerformancePoint[]): StepPerformanceRow[] {
  return chart.flatMap((c) => [
    { Step: c.label, series: "Open rate" as const, rate: c.openRatePct },
    { Step: c.label, series: "Click rate" as const, rate: c.clickRatePct },
    { Step: c.label, series: "Recovery rate" as const, rate: c.recoveryRatePct },
  ]);
}

/** Every step with its three rates and its sends, for a reader who cannot see the bars. */
export function stepPerformanceAlt(chart: readonly StepPerformancePoint[]): string {
  const parts = chart.map(
    (c) =>
      `${c.label} ${c.openRatePct}% opened, ${c.clickRatePct}% clicked, ${c.recoveryRatePct}% recovered (${c.sent} sent)`,
  );
  return `Open, click and recovery rate for each recovery email step: ${parts.join("; ")}.`;
}

/**
 * The note under the chart's title, in the place of Recova's caveat. Recova's
 * read "Recovery includes customers who updated payment after reading the
 * email, even without clicking the tracked link", true of Recova, which counted
 * any recovered result on an email step. Foxhound credits an email step only
 * through findAttributionSignals (attribution.ts): a click that is not flagged
 * as suspect, before the payment and inside the engagement window
 * (webhooks/process.ts resolveRecoveryAttribution). A truthfulness fix,
 * reported to Dustin in the J12 pull request.
 */
export const STEP_PERFORMANCE_NOTE = `Recovery counts a payment only when the customer clicked the email's link within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before paying. Clicks flagged as automated do not count.`;
