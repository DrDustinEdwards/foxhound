import { barChart } from "enarratio/lite/bar";

import type { CohortRow } from "~/lib/intelligence/mrr";
import { formatMoneyShort } from "~/lib/money-format";

import { mrrMovementAlt, mrrMovementBars, type MovementTotals } from "./console";

// The console's MRR analytics charts, drawn by Enarratio (Q1) in place of the
// hand-built SVG of app/components/charts.tsx. The MRR trend reuses the
// Intelligence dashboard's drawMrrTrend (J67); these two are the console's own
// figures: the latest month's five movements, and the share of each customer
// cohort still paying. Each returns Enarratio's figure as HTML at a width, with
// a text equivalent (capsid/conventions-web.md rule 8) and its data table.

/** The movement colours the Intelligence dashboard uses for the same series. */
const MOVEMENT_COLORS: Record<string, string> = {
  New: "var(--green)",
  Expand: "var(--blue)",
  Contract: "var(--orange)",
  Churn: "var(--red)",
  Reactivate: "var(--purple)",
};

export function drawLatestMovement(m: MovementTotals, currency: string, width: number): string {
  const bars = mrrMovementBars(m);
  return barChart({
    data: bars.map((b) => ({ Movement: b.label, kind: b.label, amount: b.units })),
    x: "Movement",
    xDomain: bars.map((b) => b.label),
    y: "amount",
    series: "kind",
    seriesDomain: bars.map((b) => b.label),
    colors: MOVEMENT_COLORS,
    xLabel: null,
    yLabel: currency.toUpperCase(),
    formatValue: (v) => formatMoneyShort(v * 100, currency),
    alt: mrrMovementAlt(m, currency),
    width,
    height: 200,
  });
}

/** The cohort chart's text equivalent, every cohort with its share. */
export function cohortAlt(rows: readonly CohortRow[]): string {
  const parts = rows.map((r) => `${r.label} ${r.values[0] ?? 0}%`);
  return `Share of each customer cohort still paying: ${parts.join(", ")}.`;
}

/** About 22px a cohort, never shorter than an axis. */
export function cohortChartHeight(count: number): number {
  return Math.max(140, 64 + count * 22);
}

export function drawCohorts(rows: readonly CohortRow[], width: number): string {
  const yLabel = "Still paying (%)";
  return barChart({
    data: rows.map((r) => ({ Cohort: r.label, share: r.values[0] ?? 0 })),
    x: "Cohort",
    xDomain: rows.map((r) => r.label),
    y: "share",
    // One bar per cohort, read across: a year of monthly cohorts does not fit
    // under a vertical axis at any width without the labels running together.
    orientation: "horizontal",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--brand-ui)" },
    formatValue: (v) => `${v}%`,
    alt: cohortAlt(rows),
    width,
    height: cohortChartHeight(rows.length),
  });
}
