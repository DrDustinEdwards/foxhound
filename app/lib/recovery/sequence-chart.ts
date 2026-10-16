import type { StepPerformancePoint } from "./sequence-performance";

// The step performance chart's data and text equivalent (row S9, J12), drawn by
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
