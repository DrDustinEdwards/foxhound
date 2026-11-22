import { formatDate } from "capsomer/behavior/time";
import { areaChart } from "enarratio/lite/area";
import type { ChartFit } from "capsomer/react/chart-frame";
import { barChart } from "enarratio/lite/bar";
import { lineChart } from "enarratio/lite/line";

import { formatMoneyShort, fromMajorUnits, toMajorUnits } from "@dustinedwards/site-runtime/money";

import {
  formatPct,
  healthAlt,
  movementAlt,
  mrrTrendAlt,
  nrrAlt,
  planAlt,
  type PlanRow,
} from "./dashboard";

// The Intelligence dashboard's five charts, drawn by Enarratio: MRR trend (area), NRR (line with a dashed 100% rule),
// MRR movement (five stacked series, contraction and churn below the baseline), plan breakdown (one bar per plan,
// largest first) and health distribution (three stacked bands). Each returns Enarratio's figure as HTML at a given
// width; the page redraws it at its panel's width. The MRR line and plan bars are amber and the "Medium risk" band
// takes the caution color every other band uses. Enarratio has no tick formatter, so ticks read as plain numbers
// under an axis label naming the unit.

/** Chart heights, including the 64px Enarratio keeps for its axes. */
const CHART_HEIGHTS = { trend: 220, nrr: 180, movement: 240, health: 240 } as const;

const whole = (minor: number, currency: string) => Math.round(toMajorUnits(minor, currency));
const unit = (currency: string) => currency.toUpperCase();

export interface TrendPoint {
  at: Date;
  totalMrrCents: number;
}

export function drawMrrTrend(
  points: readonly TrendPoint[],
  currency: string,
  width: number,
  fit: ChartFit = {},
): string {
  const yLabel = `MRR (${unit(currency)})`;
  return areaChart({
    title: "MRR trend",
    source: { name: "Stripe subscriptions" },
    data: points.map((p) => ({ Date: p.at, mrr: whole(p.totalMrrCents, currency) })),
    x: "Date",
    y: "mrr",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--accent)" },
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    formatX: (v) => formatDate(new Date(v), { style: "monthDay" }) ?? "",
    alt: mrrTrendAlt(points, currency),
    hoverTitles: false,
    width,
    height: CHART_HEIGHTS.trend,
    ...fit,
  });
}

export interface NrrPoint {
  at: Date;
  nrrPct: number | null;
}

export function drawNrr(points: readonly NrrPoint[], width: number, fit: ChartFit = {}): string {
  const yLabel = "NRR (%)";
  return lineChart({
    title: "Net Revenue Retention",
    source: { name: "Stripe subscriptions" },
    data: points.map((p) => ({
      Date: p.at,
      nrr: p.nrrPct === null ? null : Math.round(p.nrrPct * 10) / 10,
    })),
    x: "Date",
    y: "nrr",
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--blue)" },
    zero: false,
    points: false,
    references: [{ y: 100, label: "100%" }],
    formatValue: formatPct,
    formatX: (v) => formatDate(new Date(v), { style: "monthDay" }) ?? "",
    alt: nrrAlt(points),
    hoverTitles: false,
    width,
    height: CHART_HEIGHTS.nrr,
    ...fit,
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

/** The five series in legend order. */
const MOVEMENT_SERIES = ["New", "Expansion", "Reactivation", "Contraction", "Churn"] as const;
const MOVEMENT_COLORS: Record<(typeof MOVEMENT_SERIES)[number], string> = {
  New: "var(--green)",
  Expansion: "var(--blue)",
  Reactivation: "var(--purple)",
  Contraction: "var(--orange)",
  Churn: "var(--red)",
};

/** Whole units of the account currency, contraction and churn as negatives. */
function movementRows(points: readonly MovementPoint[], currency: string) {
  return points.flatMap((p) => [
    { Week: p.at, series: "New", amount: whole(p.newMrrCents, currency) },
    { Week: p.at, series: "Expansion", amount: whole(p.expansionMrrCents, currency) },
    { Week: p.at, series: "Reactivation", amount: whole(p.reactivationMrrCents, currency) },
    { Week: p.at, series: "Contraction", amount: -whole(p.contractionMrrCents, currency) },
    { Week: p.at, series: "Churn", amount: -whole(p.churnMrrCents, currency) },
  ]);
}

export function drawMovement(
  points: readonly MovementPoint[],
  currency: string,
  width: number,
  fit: ChartFit = {},
): string {
  return barChart({
    title: "MRR movement by week",
    source: { name: "Stripe subscriptions" },
    data: movementRows(points, currency),
    x: "Week",
    xType: "time",
    interval: "week",
    formatX: (start) => formatDate(start, { style: "monthDay" }) ?? "",
    y: "amount",
    series: "series",
    seriesDomain: [...MOVEMENT_SERIES],
    colors: MOVEMENT_COLORS,
    xLabel: null,
    yLabel: unit(currency),
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    alt: movementAlt(points, currency),
    hoverTitles: false,
    width,
    height: CHART_HEIGHTS.movement,
    ...fit,
  });
}

/** One bar per plan, never shorter than an axis. */
function planChartHeight(planCount: number): number {
  return Math.max(140, 64 + planCount * 36);
}

export function drawPlans(
  rows: readonly PlanRow[],
  currency: string,
  width: number,
  fit: ChartFit = {},
  source: { name: string } = { name: "Stripe subscriptions" },
): string {
  const yLabel = `MRR (${unit(currency)})`;
  return barChart({
    title: "MRR by plan",
    source,
    data: rows.map((r) => ({ Plan: r.plan, mrr: whole(r.mrrCents, currency) })),
    x: "Plan",
    y: "mrr",
    orientation: "horizontal",
    xDomain: rows.map((r) => r.plan),
    xLabel: null,
    yLabel,
    colors: { [yLabel]: "var(--accent)" },
    formatValue: (v) => formatMoneyShort(fromMajorUnits(v, currency), currency),
    alt: planAlt(rows, currency),
    hoverTitles: false,
    width,
    height: planChartHeight(rows.length),
    ...fit,
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
  "Medium risk": "var(--warn)",
  Healthy: "var(--green)",
};

export function drawHealth(days: readonly HealthDay[], width: number, fit: ChartFit = {}): string {
  const label = (d: HealthDay) =>
    formatDate(new Date(`${d.date}T00:00:00Z`), { style: "monthDay" }) ?? "";
  return barChart({
    title: "Customer health distribution",
    source: { name: "Stripe subscriptions" },
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
    hoverTitles: false,
    width,
    height: CHART_HEIGHTS.health,
    ...fit,
  });
}
