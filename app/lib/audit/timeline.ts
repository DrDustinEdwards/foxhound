import { barChart } from "enarratio/lite/bar";
import type { ChartFit } from "capsomer/react/chart-frame";

export interface ExpiringMonth {
  label: string;
  count: number;
}

const PEAK = "Most cards expiring";
const OTHER = "Cards expiring";

export function expiringCardsMonths(expiresByMonth: Record<string, number>): ExpiringMonth[] {
  return Object.entries(expiresByMonth)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 4)
    .map(([ym, count]) => {
      const [y, m] = ym.split("-");
      const label = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      return { label, count };
    });
}

/** The chart's text equivalent (capsid/conventions-web.md rule 8). */
function expiringCardsAlt(months: readonly ExpiringMonth[]): string {
  return `Cards expiring by month: ${months.map((m) => `${m.label} ${m.count}`).join(", ")}.`;
}

export function drawExpiringCardsTimeline(
  months: readonly ExpiringMonth[],
  width: number,
  fit: ChartFit = {},
): string {
  const max = Math.max(...months.map((m) => m.count));
  const series = months.some((m) => m.count !== max) ? [PEAK, OTHER] : [PEAK];
  return barChart({
    title: "Cards expiring by month",
    data: months.map((m) => ({
      month: m.label,
      kind: m.count === max ? PEAK : OTHER,
      count: m.count,
    })),
    x: "month",
    xDomain: months.map((m) => m.label),
    y: "count",
    series: "kind",
    seriesDomain: series,
    // Only the series in the chart get a color: Enarratio refuses a color for a
    // series that is not there, which is every equal-months chart.
    colors: Object.fromEntries(series.map((s) => [s, s === PEAK ? "var(--red)" : "var(--accent)"])),
    xLabel: null,
    yLabel: null,
    formatValue: (v) => String(v),
    filterBy: "x",
    alt: expiringCardsAlt(months),
    hoverTitles: false,
    width,
    height: 120,
    ...fit,
  });
}
