// The recovery dashboard's charts (routes/app/recovery/index.tsx split): rate,
// revenue, decline breakdown, email category and timing. Presentational.

import { areaChart } from "enarratio/lite/area";
import { barChart } from "enarratio/lite/bar";
import { sparkline } from "enarratio";
import { Meter } from "capsomer/react/meter";
import { ChartFrame } from "capsomer/react/chart-frame";
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
  recoveryRateAlt,
  recoveryTimingAlt,
} from "~/lib/dashboard/recovery-dashboard";
import { formatMoney, fromMajorUnits } from "~/lib/money-format";

// ---- Charts ----

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
      <Panel title={title}>
        <ChartFrame noData={{ title, reason: "Not enough data yet. Recovery rate will appear after your first recovery." }} />
      </Panel>
    );
  }
  const rows = w.recoveryRateDaily.map((p) => ({ Day: p.date, rate: p.rate }));
  return (
    <Panel title={title}>
      <ChartFrame
        gridlines="none"
        width={HALF_WIDTH}
        draw={(width) =>
          areaChart({
            title,
            data: rows,
            x: "Day",
            y: "rate",
            // Recova's green line and fill.
            colors: { "Recovery rate (%)": "var(--green)" },
            xLabel: null,
            yLabel: "Recovery rate (%)",
            formatValue: pctText,
            formatX: (d) => formatShortDate(d instanceof Date ? d : new Date(d)),
            alt: recoveryRateAlt(w.recoveryRateDaily, w.rangeLabel),
            hoverTitles: false,
            width,
            height: RATE_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

export function RevenueChart({ w, nowMs }: { w: RecoveryDashboardWindow; nowMs: number }) {
  // Recova's buildDailyChart: 7, 30 or 90 days, and 90 for all time.
  const days = w.rangeDays;
  const { rows, currencies } = dailyRecoveredRows(w.recoveredPayments, days, nowMs);
  const single = currencies.length === 1 ? currencies[0]! : null;
  const title = `Recovered revenue · ${w.rangeLabel}`;
  return (
    <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-[2fr_1fr]">
      <Panel title={title} more={
        <span className="font-mono text-body font-semibold tabular-nums text-text">
          {formatCurrencyTotals(w.recoveredRevenue)}
        </span>
      }>
        <ChartFrame
          gridlines="none"
          width={SIDE_WIDTH}
          draw={(width) =>
            barChart({
              title,
              data: rows,
              x: "Day",
              xType: "time",
              interval: "day",
              y: "amount",
              // One series per currency, only when there is more than one,
              // because a sum across currencies is meaningless.
              ...(single ? {} : { series: "currency" as const, layout: "grouped" as const }),
              colors: single ? { Recovered: "var(--green)" } : undefined,
              xLabel: null,
              yLabel: "Recovered",
              formatValue: (v) => (single ? formatMoney(fromMajorUnits(v, single), single) : v.toFixed(2)),
              formatX: (d) => formatShortDate(d),
              maxXTicks: 4,
              alt: recoveredRevenueAlt(rows, days),
              hoverTitles: false,
              width,
              height: REVENUE_HEIGHT,
            })
          }
        />
        <div className="flex justify-between text-micro text-text-tertiary">
          <span>{days}d ago</span>
          <span>Today</span>
        </div>
      </Panel>

      {/* Recova's email side panel, labeled with the range as Recova's was.
          Recova's query had no date filter (lib/dashboard-data.ts), so its
          label was untrue; here the figures are the range's, so it is true. */}
      <Panel title="Email performance">
        <div className="flex flex-col gap-4">
          <div>
            <p className="m-0 text-micro text-text-tertiary">Emails sent ({w.rangeLabel})</p>
            <p className="m-0 font-mono text-title font-semibold tabular-nums text-text">{w.emailsSentInRange.sent}</p>
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
        <p className="m-0 text-label text-text-subtle">No declined payments yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row) => (
            <Meter
              as="li"
              key={row.category}
              label={row.label}
              size="sm"
              value={row.pct}
              max={100}
              display={
                <span className="inline-flex items-center gap-3">
                  {row.spark.some((v) => v > 0) ? (
                    <span
                      className="inline-flex"
                      // A sparkline beside a figure needs no frame (Capsomer's
                      // chart frame, "When not to"): Enarratio's inline SVG is
                      // named by its own sentence (count, first, last, lowest,
                      // highest), so the trend is text as well.
                      dangerouslySetInnerHTML={{
                        __html: sparkline({
                          values: row.spark,
                          label: `${row.label} failures per day, last 30 days`,
                          width: 60,
                          height: 24,
                          endDot: false,
                          inline: true,
                        }),
                      }}
                    />
                  ) : null}
                  <span className="font-mono text-micro text-text-subtle">{declineRowText(row)}</span>
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
    return (
      <Panel title={title}>
        <ChartFrame noData={{ title, reason: "No recovery emails sent yet." }} />
      </Panel>
    );
  }
  return (
    <Panel title={title}>
      <ChartFrame
        gridlines="none"
        width={SIDE_WIDTH}
        draw={(width) =>
          barChart({
            title,
            data: rows,
            x: "Category",
            y: "rate",
            series: "series",
            layout: "grouped",
            orientation: "horizontal",
            // Recova's legend order and colors: Open rate green, Click rate blue.
            seriesDomain: ["Open rate", "Click rate"],
            colors: { "Open rate": "var(--green)", "Click rate": "var(--blue)" },
            xLabel: null,
            yLabel: "Rate (%)",
            formatValue: pctText,
            alt: emailCategoryAlt(w.emailCategoryPerformance),
            hoverTitles: false,
            width,
            height: EMAIL_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

export function RecoveryTimingChart({ w }: { w: RecoveryDashboardWindow }) {
  const title = "When recoveries happen";
  const total = w.recoveryTimingBuckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return (
      <Panel title={title}>
        <ChartFrame noData={{ title, reason: "No recoveries yet." }} />
      </Panel>
    );
  }
  // Recova draws the counts and prints each bar's share on top of it; the
  // share has the same shape, so it is what is drawn, against a % axis.
  const rows = w.recoveryTimingBuckets.map((b) => ({ Bucket: b.dayBucket, share: b.percentage }));
  return (
    <Panel title={title}>
      <ChartFrame
        gridlines="none"
        width={HALF_WIDTH}
        draw={(width) =>
          barChart({
            title,
            data: rows,
            x: "Bucket",
            y: "share",
            xDomain: w.recoveryTimingBuckets.map((b) => b.dayBucket),
            colors: { "Share of recoveries (%)": "var(--green)" },
            xLabel: null,
            yLabel: "Share of recoveries (%)",
            formatValue: pctText,
            alt: recoveryTimingAlt(w.recoveryTimingBuckets),
            hoverTitles: false,
            width,
            height: TIMING_HEIGHT,
          })
        }
      />
    </Panel>
  );
}
