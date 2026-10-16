import { barChart } from "enarratio/lite/bar";

// Recova's ExpiringCardsTimeline (components/audit/ExpiringCardsTimeline.tsx,
// blob 33537a84), drawn by Enarratio (Q1) in place of recharts. Pure and
// client-safe: the audit sections draw it on the server and redraw it at the
// measured width in the browser (app/components/enarratio-figure.tsx).
//
// WHAT IS PLOTTED IS RECOVA'S: the months with at least one card expiring,
// oldest first, at most four, each labelled "Oct 2026", one bar per month, and
// the month (or months) with the most cards marked in red. Recova marks the
// peak by colour alone; here the peak is its own series, so the legend and the
// data table say which month it is in words too (WCAG 1.4.1). The other bars
// are teal (Q11). Recova hides the value axis; Enarratio
// keeps one, which is the chart library's difference and is covered by Q1.

export interface ExpiringMonth {
  /** "Oct 2026", Recova's tick. */
  label: string;
  count: number;
}

const PEAK = "Most cards expiring";
const OTHER = "Cards expiring";

/** Recova's months: non-zero buckets, sorted by their YYYY-MM key, first four. */
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
export function expiringCardsAlt(months: readonly ExpiringMonth[]): string {
  return `Cards expiring by month: ${months.map((m) => `${m.label} ${m.count}`).join(", ")}.`;
}

export function drawExpiringCardsTimeline(months: readonly ExpiringMonth[], width: number): string {
  const max = Math.max(...months.map((m) => m.count));
  const series = months.some((m) => m.count !== max) ? [PEAK, OTHER] : [PEAK];
  return barChart({
    data: months.map((m) => ({ month: m.label, kind: m.count === max ? PEAK : OTHER, count: m.count })),
    x: "month",
    xDomain: months.map((m) => m.label),
    y: "count",
    series: "kind",
    seriesDomain: series,
    colors: { [PEAK]: "var(--red)", [OTHER]: "var(--brand-ui)" },
    xLabel: null,
    yLabel: null,
    formatValue: (v) => String(v),
    filterBy: "x",
    alt: expiringCardsAlt(months),
    width,
    height: 120,
  });
}
