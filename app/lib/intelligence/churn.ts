import { lineChart } from "enarratio/lite/line";
import type { ChartFit } from "capsomer/react/chart-frame";

// Pure churn-surface helpers, separate from views.server.ts because the churn route's component needs them and a
// value import from a *.server.ts module in a component fails the client build (types are erased, values are not).

export interface ChurnRatePointLike {
  at: Date;
  voluntaryPct: number | null;
  involuntaryPct: number | null;
}

const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "Sep 2025": a snapshot's month, pinned to UTC so server and browser agree. Shared by the chart's axis table and text alternative. */
function formatChurnMonth(date: Date | number): string {
  return MONTH.format(date);
}

function formatChurnPct(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function seriesSentence(
  name: string,
  points: readonly ChurnRatePointLike[],
  pick: (p: ChurnRatePointLike) => number | null,
): string {
  const present = points.filter((p) => pick(p) !== null);
  if (present.length === 0) return `${name} churn has no rate yet`;
  const first = present[0];
  const last = present[present.length - 1];
  const at = (p: ChurnRatePointLike) =>
    `${formatChurnPct(pick(p) as number)} in ${formatChurnMonth(p.at)}`;
  if (present.length === 1) return `${name} churn was ${at(first)}`;
  return `${name} churn went from ${at(first)} to ${at(last)}`;
}

/** The churn-rate chart's text alternative: the window and, per series, its first and last rate with the month of
 *  each (a series can start or end on a gap). Computed from the same points the chart draws; a month with no rate
 *  is a gap, never a zero. */
export function churnRateAlt(points: readonly ChurnRatePointLike[]): string {
  if (points.length === 0) return "Monthly churn rate: no snapshots yet.";
  const start = formatChurnMonth(points[0].at);
  const end = formatChurnMonth(points[points.length - 1].at);
  const window = start === end ? start : `${start} to ${end}`;
  const involuntary = seriesSentence("Involuntary", points, (p) => p.involuntaryPct);
  const voluntary = seriesSentence("voluntary", points, (p) => p.voluntaryPct);
  return `Monthly churn rate, ${window}. ${involuntary}; ${voluntary}.`;
}

// Enarratio draws its legend outside the SVG and keeps 64px of the height for its axes.
const CHART_HEIGHT = 220;

interface ChurnRow {
  // Capitalized because Enarratio names the data table's first column after it.
  Month: string;
  series: "Involuntary" | "Voluntary";
  rate: number | null;
}

export function drawChurnRate(
  points: readonly ChurnRatePointLike[],
  width: number,
  fit: ChartFit = {},
): string {
  const data: ChurnRow[] = points.flatMap((p) => {
    const Month = p.at.toISOString().slice(0, 10);
    return [
      { Month, series: "Involuntary" as const, rate: p.involuntaryPct },
      { Month, series: "Voluntary" as const, rate: p.voluntaryPct },
    ];
  });
  return lineChart({
    title: "Churn rate over time",
    data,
    x: "Month",
    y: "rate",
    series: "series",
    seriesDomain: ["Involuntary", "Voluntary"],
    // Involuntary on the error color, Voluntary on tertiary text. Enarratio has no per-series dash.
    colors: { Involuntary: "var(--crit)", Voluntary: "var(--dim)" },
    xLabel: null,
    // Enarratio has no tick format, so ticks read as plain numbers under an axis label naming the unit.
    yLabel: "Churn rate (%)",
    formatValue: formatChurnPct,
    formatX: formatChurnMonth,
    alt: churnRateAlt(points),
    hoverTitles: false,
    width,
    height: CHART_HEIGHT,
    ...fit,
  });
}
