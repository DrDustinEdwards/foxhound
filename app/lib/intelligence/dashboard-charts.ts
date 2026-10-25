import { areaChart } from "enarratio/lite/area";
import { barChart } from "enarratio/lite/bar";
import { lineChart } from "enarratio/lite/line";

import { formatDateMonthDay } from "~/lib/date-format";
import { formatMoneyShort, fromMajorUnits, toMajorUnits } from "~/lib/money-format";

import {
  formatPct,
  healthAlt,
  movementAlt,
  mrrTrendAlt,
  nrrAlt,
  planAlt,
  type PlanRow,
} from "./dashboard";

// The Intelligence dashboard's five charts (row S16, job J67), drawn by
// Enarratio (Q1) from what Recova's charts plot: MRRTrendChart (area),
// NRRChart (line with a dashed 100% rule), MRRMovementChart (five stacked
// series, contraction and churn below the baseline), PlanBreakdown (one bar
// per plan, largest first) and HealthDistributionChart (three stacked bands).
// Each returns Enarratio's figure as HTML at a given width; the page redraws
// it at its panel's width.
//
// Colours are Recova's, by Foxhound's token of the same name, except Recova's
// accent colour: the MRR line and the plan bars are amber, and the
// "Medium risk" band takes the caution colour every other band in the app uses.
//
// Enarratio 0.3.1 has no tick formatter, so Recova's "$1,200" and "102%" ticks
// read as plain numbers under an axis label naming the unit, as on the churn
// chart (an Enarratio gap, named in the J67 pull request).

/** Recova's chart heights plus the 64px Enarratio keeps for its axes, so the
 *  plotted area is about Recova's. */
const CHART_HEIGHTS = { trend: 220, nrr: 180, movement: 240, health: 240 } as const;

/** Whole units of the account currency (yen for JPY, not hundredths of it). */
const whole = (minor: number, currency: string) => Math.round(toMajorUnits(minor, currency));
const unit = (currency: string) => currency.toUpperCase();

export interface TrendPoint {
  at: Date;
  totalMrrCents: number;
}

export function drawMrrTrend(points: readonly TrendPoint[], currency: string, width: number): string {
  const yLabel = `MRR (${unit(currency)})`;
  return areaChart({
    data: points.map((p) => ({ Date: p.at, mrr: whole(p.totalMrrCents, currency) })),
    x: "Date",
    y: "mrr",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--brand-ui)" },
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    formatX: (v) => formatDateMonthDay(new Date(v)),
    alt: mrrTrendAlt(points, currency),
    width,
    height: CHART_HEIGHTS.trend,
  });
}

export interface NrrPoint {
  at: Date;
  nrrPct: number | null;
}

export function drawNrr(points: readonly NrrPoint[], width: number): string {
  const yLabel = "NRR (%)";
  return lineChart({
    data: points.map((p) => ({ Date: p.at, nrr: p.nrrPct === null ? null : Math.round(p.nrrPct * 10) / 10 })),
    x: "Date",
    y: "nrr",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--blue)" },
    // Recova's y domain is ['auto', 'auto'] and its line has no dots.
    zero: false,
    points: false,
    references: [{ y: 100, label: "100%" }],
    formatValue: formatPct,
    formatX: (v) => formatDateMonthDay(new Date(v)),
    alt: nrrAlt(points),
    width,
    height: CHART_HEIGHTS.nrr,
  });
}

export interface MovementPoint {
  at: Date;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
}

/** Recova's five series, in its legend order, with its colours. */
const MOVEMENT_SERIES = ["New", "Expansion", "Reactivation", "Contraction", "Churn"] as const;
const MOVEMENT_COLORS: Record<(typeof MOVEMENT_SERIES)[number], string> = {
  New: "var(--green)",
  Expansion: "var(--blue)",
  Reactivation: "var(--purple)",
  Contraction: "var(--orange)",
  Churn: "var(--red)",
};

/** Recova works in whole dollars and draws contraction and churn as negatives
 *  (MRRMovementChart.tsx:32-38); here whole units of the account currency. */
function movementRows(points: readonly MovementPoint[], currency: string) {
  return points.flatMap((p) => [
    { Month: p.at, series: "New", amount: whole(p.newMrrCents, currency) },
    { Month: p.at, series: "Expansion", amount: whole(p.expansionMrrCents, currency) },
    { Month: p.at, series: "Reactivation", amount: whole(p.reactivationMrrCents, currency) },
    { Month: p.at, series: "Contraction", amount: -whole(p.contractionMrrCents, currency) },
    { Month: p.at, series: "Churn", amount: -whole(p.churnMrrCents, currency) },
  ]);
}

export function drawMovement(points: readonly MovementPoint[], currency: string, width: number): string {
  return barChart({
    data: movementRows(points, currency),
    x: "Month",
    // One bar per monthly snapshot, named by its date as Recova names its bars.
    xType: "time",
    interval: "month",
    formatX: (start) => formatDateMonthDay(start),
    y: "amount",
    series: "series",
    seriesDomain: [...MOVEMENT_SERIES],
    colors: MOVEMENT_COLORS,
    xLabel: null,
    yLabel: unit(currency),
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    alt: movementAlt(points, currency),
    width,
    height: CHART_HEIGHTS.movement,
  });
}

/** One bar per plan: about Recova's row rhythm, never shorter than an axis. */
function planChartHeight(planCount: number): number {
  return Math.max(140, 64 + planCount * 36);
}

export function drawPlans(rows: readonly PlanRow[], currency: string, width: number): string {
  const yLabel = `MRR (${unit(currency)})`;
  return barChart({
    data: rows.map((r) => ({ Plan: r.plan, mrr: whole(r.mrrCents, currency) })),
    x: "Plan",
    y: "mrr",
    orientation: "horizontal",
    xDomain: rows.map((r) => r.plan),
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--brand-ui)" },
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    alt: planAlt(rows, currency),
    width,
    height: planChartHeight(rows.length),
  });
}

export interface HealthDay {
  date: string;
  atRisk: number;
  watch: number;
  healthy: number;
}

const HEALTH_SERIES = ["High risk", "Medium risk", "Healthy"] as const;
const HEALTH_COLORS: Record<(typeof HEALTH_SERIES)[number], string> = {
  "High risk": "var(--red)",
  "Medium risk": "var(--warning-text)",
  Healthy: "var(--green)",
};

export function drawHealth(days: readonly HealthDay[], width: number): string {
  const label = (d: HealthDay) => formatDateMonthDay(new Date(`${d.date}T00:00:00Z`));
  return barChart({
    data: days.flatMap((d) => [
      { Day: label(d), band: "High risk", count: d.atRisk },
      { Day: label(d), band: "Medium risk", count: d.watch },
      { Day: label(d), band: "Healthy", count: d.healthy },
    ]),
    x: "Day",
    xDomain: days.map(label),
    y: "count",
    series: "band",
    seriesDomain: [...HEALTH_SERIES],
    colors: HEALTH_COLORS,
    xLabel: null,
    yLabel: "Customers",
    alt: healthAlt(days),
    width,
    height: CHART_HEIGHTS.health,
  });
}
