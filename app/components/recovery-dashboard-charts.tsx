// The recovery dashboard's charts (routes/app/recovery/index.tsx split): rate,
// revenue, decline breakdown, email category and timing. Presentational.

import { areaChart } from "enarratio/lite/area";
import { barChart } from "enarratio/lite/bar";
import { sparkline } from "enarratio/lite/sparkline";
import { Meter } from "capsomer/react/meter";
import { ChartPanel } from "capsomer/react/chart-frame";
import { describeSeries, drawWith } from "capsomer/behavior/chart-frame";
import { Panel } from "capsomer/react/panel";
import "~/components/charts.css";
import type { RecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import {
  dailyRecoveredRows,
  declineRows,
  declineRowText,
  emailCategoryAlt,
  emailCategoryRows,
  formatCurrencyTotals,
  formatShortDate,
  recoveredRevenueAlt,
  recoveryTimingAlt,
} from "~/lib/dashboard/recovery-dashboard";
import type { DailyRatePoint } from "~/lib/dashboard/recovery-window";
import { formatMoney, fromMajorUnits } from "@dustinedwards/site-runtime/money";
import { markup } from "capsomer/behavior/trusted-html";

// ---- Charts ----

// Here, beside its only chart, so the shared recovery-dashboard module
// (the payments list loads it) does not pull in chart-frame.
/** The sentence a reader without the chart gets: the running rate over the
 *  range, its latest value, its spread and where it peaked. */
export function recoveryRateAlt(points: readonly DailyRatePoint[], rangeLabel: string): string {
  const present = points.filter((p): p is { date: string; rate: number } => p.rate !== null);
  if (!present.length) return `Recovery rate, ${rangeLabel}: no failed payments in this range yet.`;
  return describeSeries({
    what: `Running recovery rate, ${rangeLabel}`,
    x: present.map((p) => formatShortDate(p.date)),
    values: present.map((p) => p.rate),
    format: (v) => `${v}%`,
    at: "on",
    empty: `Running recovery rate, ${rangeLabel}: 0%.`,
  });
}

// The drawing's width before its container is measured, and on the server:
// about each panel's body in Recova's 1280px column.
const HALF_WIDTH = 560;
const SIDE_WIDTH = 440;
// Recova's charts are 180px (rate, timing), 160px (email) and 120px (revenue)
// tall with their axes inside; Enarratio keeps part of the height for its
// axes, so each is drawn a little taller.
const RATE_HEIGHT = 220;
const TIMING_HEIGHT = 220;
const EMAIL_HEIGHT = 240;
const REVENUE_HEIGHT = 180;

const pctText = (v: number) => `${v}%`;

export function RecoveryRateChart({ w }: { w: RecoveryDashboardWindow }) {
  const title = `Recovery rate · ${w.rangeLabel}`;
  if (!w.recoveryRateDaily.some((p) => p.rate !== null)) {
    return (
      <ChartPanel
        title={title}
        empty={{
          reason: "Not enough data yet. Recovery rate will appear after your first recovery.",
        }}
      />
    );
  }
  const rows = w.recoveryRateDaily.map((p) => ({ Day: p.date, rate: p.rate }));
  return (
    <ChartPanel
      title={title}
      gridlines="none"
      width={HALF_WIDTH}
      draw={drawWith(areaChart, {
        title,
        data: rows,
        x: "Day" as const,
        y: "rate" as const,
        // Recova's green line and fill.
        colors: { "Recovery rate (%)": "var(--green)" },
        xLabel: null,
        yLabel: "Recovery rate (%)",
        formatValue: pctText,
        formatX: (d) => formatShortDate(d instanceof Date ? d : new Date(d)),
        alt: recoveryRateAlt(w.recoveryRateDaily, w.rangeLabel),
        hoverTitles: false,
        height: RATE_HEIGHT,
      })}
    />
  );
}

export function RevenueChart({ w, nowMs }: { w: RecoveryDashboardWindow; nowMs: number }) {
  // Recova's buildDailyChart: 7, 30 or 90 days, and 90 for all time.
  const days = w.rangeDays;
  const { rows, currencies } = dailyRecoveredRows(w.recoveredPayments, days, nowMs);
  const single = currencies.length === 1 ? currencies[0]! : null;
  const title = `Recovered revenue · ${w.rangeLabel}`;
  return (
    <div className="fh-recchart-grid">
      <ChartPanel
        title={title}
        more={
          <span className="fh-mono fh-body fh-semibold cap-num fh-text">
            {formatCurrencyTotals(w.recoveredRevenue)}
          </span>
        }
        gridlines="none"
        width={SIDE_WIDTH}
        draw={drawWith(barChart, {
          title,
          data: rows,
          x: "Day" as const,
          xType: "time" as const,
          interval: "day" as const,
          y: "amount" as const,
          // One series per currency, only when there is more than one,
          // because a sum across currencies is meaningless.
          ...(single ? {} : { series: "currency" as const, layout: "grouped" as const }),
          colors: single ? { Recovered: "var(--green)" } : undefined,
          xLabel: null,
          yLabel: "Recovered",
          formatValue: (v) =>
            single ? formatMoney(fromMajorUnits(v, single), single) : v.toFixed(2),
          formatX: (d) => formatShortDate(d),
          maxXTicks: 4,
          alt: recoveredRevenueAlt(rows, days),
          hoverTitles: false,
          height: REVENUE_HEIGHT,
        })}
      >
        <div className="fh-recchart-axis fh-tiny fh-quiet">
          <span>{days}d ago</span>
          <span>Today</span>
        </div>
      </ChartPanel>

      {/* Recova's email side panel, labeled with the range as Recova's was.
          Recova's query had no date filter (lib/dashboard-data.ts), so its
          label was untrue; here the figures are the range's, so it is true. */}
      <Panel title="Email performance">
        <div className="cap-stack" data-gap="5">
          <div>
            <p className="fh-tiny fh-quiet">Emails sent ({w.rangeLabel})</p>
            <p className="fh-mono fh-title fh-semibold cap-num fh-text">
              {w.emailsSentInRange.sent}
            </p>
          </div>
          <Meter
            label="Open rate"
            size="sm"
            value={w.emailsSentInRange.openRatePct}
            max={100}
            display={`${w.emailsSentInRange.openRatePct}%`}
            valueText={`${w.emailsSentInRange.openRatePct}% of recovery emails opened.`}
          />
          <Meter
            label="Click rate"
            size="sm"
            value={w.emailsSentInRange.clickRatePct}
            max={100}
            display={`${w.emailsSentInRange.clickRatePct}%`}
            valueText={`${w.emailsSentInRange.clickRatePct}% of recovery emails clicked.`}
          />
        </div>
      </Panel>
    </div>
  );
}

export function DeclineBreakdown({ w }: { w: RecoveryDashboardWindow }) {
  const rows = declineRows(w);
  return (
    <Panel title="Decline breakdown">
      {w.totalFailedCount === 0 ? (
        <p className="fh-small fh-faint">No declined payments yet.</p>
      ) : (
        <ul className="cap-stack" data-gap="4">
          {rows.map((row) => (
            <Meter
              as="li"
              key={row.category}
              label={row.label}
              size="sm"
              value={row.pct}
              max={100}
              display={
                <span className="fh-recchart-key">
                  {row.spark.some((v) => v > 0) ? (
                    <span
                      className="fh-recchart-swatch"
                      // A sparkline beside a figure needs no frame (Capsomer's
                      // chart frame, "When not to"): Enarratio's inline SVG is
                      // named by its own sentence (count, first, last, lowest,
                      // highest), so the trend is text as well.
                      dangerouslySetInnerHTML={markup(
                        sparkline({
                          values: row.spark,
                          label: `${row.label} failures per day, last 30 days`,
                          width: 60,
                          height: 24,
                          endDot: false,
                        }),
                      )}
                    />
                  ) : null}
                  <span className="fh-mono fh-tiny fh-faint">{declineRowText(row)}</span>
                </span>
              }
              valueText={`${row.count} failed payments, ${row.pct}% of all${row.recoveredPct !== null ? `, ${row.recoveredPct}% recovered` : ""}.`}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function EmailCategoryChart({ w }: { w: RecoveryDashboardWindow }) {
  const { rows, totalSent } = emailCategoryRows(w.emailCategoryPerformance);
  const title = "Email performance by decline type";
  if (totalSent === 0) {
    return <ChartPanel title={title} empty={{ reason: "No recovery emails sent yet." }} />;
  }
  return (
    <ChartPanel
      title={title}
      gridlines="none"
      width={SIDE_WIDTH}
      draw={drawWith(barChart, {
        title,
        data: rows,
        x: "Category" as const,
        y: "rate" as const,
        series: "series" as const,
        layout: "grouped" as const,
        orientation: "horizontal" as const,
        // Recova's legend order and colors: Open rate green, Click rate blue.
        seriesDomain: ["Open rate", "Click rate"],
        colors: { "Open rate": "var(--green)", "Click rate": "var(--blue)" },
        xLabel: null,
        yLabel: "Rate (%)",
        formatValue: pctText,
        alt: emailCategoryAlt(w.emailCategoryPerformance),
        hoverTitles: false,
        height: EMAIL_HEIGHT,
      })}
    />
  );
}

export function RecoveryTimingChart({ w }: { w: RecoveryDashboardWindow }) {
  const title = "When recoveries happen";
  const total = w.recoveryTimingBuckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return <ChartPanel title={title} empty={{ reason: "No recoveries yet." }} />;
  }
  // Recova draws the counts and prints each bar's share on top of it; the
  // share has the same shape, so it is what is drawn, against a % axis.
  const rows = w.recoveryTimingBuckets.map((b) => ({ Bucket: b.dayBucket, share: b.percentage }));
  return (
    <ChartPanel
      title={title}
      gridlines="none"
      width={HALF_WIDTH}
      draw={drawWith(barChart, {
        title,
        data: rows,
        x: "Bucket" as const,
        y: "share" as const,
        xDomain: w.recoveryTimingBuckets.map((b) => b.dayBucket),
        colors: { "Share of recoveries (%)": "var(--green)" },
        xLabel: null,
        yLabel: "Share of recoveries (%)",
        formatValue: pctText,
        alt: recoveryTimingAlt(w.recoveryTimingBuckets),
        hoverTitles: false,
        height: TIMING_HEIGHT,
      })}
    />
  );
}
