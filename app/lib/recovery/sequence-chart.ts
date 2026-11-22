import { barChart } from "enarratio/lite/bar";
import type { ChartFit } from "capsomer/react/chart-frame";
import { EMAIL_ENGAGEMENT_WINDOW_DAYS } from "~/lib/constants";

import type { StepPerformancePoint } from "./sequence-performance";

// Pure, so the route draws and the tests read the same rows.

/** Beside the chart's title. Foxhound credits an email step only through
 *  findAttributionSignals (attribution.ts): a click not flagged as suspect,
 *  before the payment and inside the engagement window. */
export const STEP_PERFORMANCE_NOTE = `Recovery counts a payment only when the customer clicked the email's link within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before paying. Clicks flagged as automated do not count.`;

const STEP_PERFORMANCE_SERIES = ["Open rate", "Click rate", "Recovery rate"] as const;

interface StepPerformanceRow {
  Step: string;
  series: (typeof STEP_PERFORMANCE_SERIES)[number];
  rate: number;
}

function stepPerformanceRows(chart: readonly StepPerformancePoint[]): StepPerformanceRow[] {
  return chart.flatMap((c) => [
    { Step: c.label, series: "Open rate" as const, rate: c.openRatePct },
    { Step: c.label, series: "Click rate" as const, rate: c.clickRatePct },
    { Step: c.label, series: "Recovery rate" as const, rate: c.recoveryRatePct },
  ]);
}

/** Every step with its three rates and its sends, for a reader who cannot see the bars. */
function stepPerformanceAlt(chart: readonly StepPerformancePoint[]): string {
  const parts = chart.map(
    (c) =>
      `${c.label} ${c.openRatePct}% opened, ${c.clickRatePct}% clicked, ${c.recoveryRatePct}% recovered (${c.sent} sent)`,
  );
  return `Open, click and recovery rate for each recovery email step: ${parts.join("; ")}.`;
}

const CHART_HEIGHT = 220;
// About the width of the longest step name ("Revocation email") at the axis's text size.
const X_LABEL_WIDTH = 110;

/** The step performance chart at a width: Open, Click and Recovery rate per step, grouped. */
export function drawStepPerformance(
  chart: readonly StepPerformancePoint[],
  width: number,
  fit: ChartFit = {},
): string {
  return barChart({
    title: "Step performance",
    data: stepPerformanceRows(chart),
    x: "Step",
    xDomain: chart.map((c) => c.label),
    y: "rate",
    series: "series",
    layout: "grouped",
    seriesDomain: STEP_PERFORMANCE_SERIES,
    colors: {
      "Open rate": "var(--green)",
      "Click rate": "var(--blue)",
      "Recovery rate": "var(--accent)",
    },
    xLabel: null,
    yLabel: "Rate (%)",
    formatValue: (v) => `${v}%`,
    maxXTicks: Math.max(2, Math.floor(width / X_LABEL_WIDTH)),
    alt: stepPerformanceAlt(chart),
    hoverTitles: false,
    width,
    height: CHART_HEIGHT,
    ...fit,
  });
}
