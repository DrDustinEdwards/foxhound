import type { ComponentType, ReactNode } from "react";
import { Activity, AlertCircle, ArrowRight, Clock, CreditCard, Percent, RefreshCw, Send, Tag, TrendingUp } from "lucide-react";
import { Link } from "react-router";
import { areaChart } from "enarratio/lite/area";
import { barChart } from "enarratio/lite/bar";
import { sparkline } from "enarratio";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Meter } from "capsomer/react/meter";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Pill, Status, type Tone as StatusTone } from "capsomer/react/status";
import { TabLink, TabsNav } from "capsomer/react/tabs";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/empty.css";
import "capsomer/meter.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/status.css";
import "capsomer/table.css";
import "capsomer/tabs.css";
import "./dashboard.css";

import { EnarratioFigure } from "~/components/enarratio-figure";
import { RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import {
  getRecoveryDashboardWindow,
  UPCOMING_STEPS_WINDOW_MS,
  type RecoveryDashboardWindow,
} from "~/lib/dashboard/recovery-window.server";
import {
  formatRelativeTime,
  RECOVERY_RANGES,
  resolveRangeCutoff,
  type RecoveryRange,
  type WebhookHealthTone,
} from "~/lib/dashboard/recovery-window";
import {
  atRiskPctOfMrr,
  dailyRecoveredRows,
  declineLabel,
  declineRows,
  declineRowText,
  deliverabilityFigures,
  emailCategoryAlt,
  emailCategoryRows,
  formatCurrencyTotals,
  formatLongDate,
  formatShortDate,
  hoursFromMs,
  onboardingChecklistState,
  paymentStepSummary,
  RECOVERY_FEE_LABEL,
  recoveredRevenueAlt,
  recoveryRateAlt,
  recoveryTimingAlt,
  roiColumn,
  type OnboardingChecklistState,
  type PaymentStepSummary,
  type RoiColumn,
  withoutHoverTitles,
} from "~/lib/dashboard/recovery-dashboard";
import { recoveryRateBand, recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatRelativeFuture, formatTimestamp } from "~/lib/date-format";
import { formatMoney } from "~/lib/money-format";
import { priorFailureCount } from "~/lib/recovery/prior-failures";
import { listStepsForFailedPayments } from "~/lib/recovery/queries.server";
import { getDashboardOnboardingProfile, getDeliverabilityCounts, listAttributedRecoveredSince, listBillableRecoveredForRoi } from "~/lib/recovery/dashboard-queries.server";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  failedPaymentStatusTone,
  formatStepType,
} from "~/lib/recovery/labels";

import type { Route } from "./+types/index";

// /recovery/dashboard (row S5, job J74). Recova is the spec: its page,
// app/(app)/recovery/dashboard/page.tsx at blob 208b0066, and every component
// it renders, each read whole at the blob J74 names (StatCards b1923468,
// ROIWidget 549b89ef, DeclineBreakdown 79b7de3f, DeclineSparkline a7ce51f5,
// RecoveryQueue c84fdca1, WinBackCard 10cf28fb, BenchmarkCard 0efb234c,
// DeliverabilityPanel 87a88d88, OnboardingChecklist f4284965, PaymentsTable
// 3dc398a2, RecoveryRateChart 52e207d6, RecoveryTimingChart f635f08d,
// EmailCategoryChart b4ed4bef, RevenueChart 2932dac5, DynamicCharts 8a5510e6),
// with lib/dashboard-data.ts at e1dfbcaa and components/recovery/PaymentRow.tsx
// at 0d2e1f52. In Recova's order: the getting-started checklist or the
// watching banner, the head, the primary stats, the ROI widget, the two
// time-series panels, decline analysis, timing beside win-back, the queue, the
// secondary stats, then the failed-payments table.
//
// Built from Capsomer 0.9.0's parts (Q10) with every chart drawn by Enarratio
// (Q1), teal throughout (Q11). No Foxhound CSS sits over a Capsomer component;
// dashboard.css only hides Enarratio's gridlines, which Recova's charts never
// drew. Recova's per-category colours, its green and red figures inside
// panels, and its 12px radius wait for Capsomer's per-site layer (capsomer
// job_ec5ec0754626), listed in the J74 pull request.
//
// Two Recova panels are not here, each for a reason in the source:
// BenchmarkCard renders only from a benchmark_data row with metric_name
// recovery_rate_bps in the industry or all_merchants cohort; Foxhound's
// benchmark_data holds only the seeded leakage estimator rows, and nothing
// writes a recovery-rate row, so the card could never render (the docs say the
// dashboard shows no outside benchmark); and the open-disputes card shows only
// when the Disputes product is inactive, which cannot happen here, because
// Disputes has no product gate in Foxhound (app/lib/nav/manifest.ts).
//
// The deliverability panel is Recova's on what Foxhound records: sends from
// email_sends, bounces and spam complaints from the suppressions the Email
// Service events consumer writes. Foxhound stores no delivered event, so
// Recova's delivered rate and the alert built on it are not shown. The
// consumer does not yet know which account an event belongs to (it writes
// account_id null), so until it maps an event back through email_sends the
// panel shows its empty state, worded to promise nothing.
//
// Recova's page also set accounts.onboarding_completed once all three
// checklist steps were done, so the checklist stayed gone afterwards; Foxhound
// recomputes it on every load, so clearing the sender name brings it back.

export function meta() {
  return [{ title: "Recovery - Foxhound" }];
}

function parseRange(value: string | null): RecoveryRange {
  return (RECOVERY_RANGES as readonly string[]).includes(value ?? "") ? (value as RecoveryRange) : "30d";
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();
  const range = parseRange(new URL(request.url).searchParams.get("range"));

  // `data` follows the range selector; `data30d` is always 30 days, for the
  // stat cards and the timing chart, and is the same read when the range is
  // already 30d, as in Recova's page.
  const [data, data30dRaw, lifetimeStats, profile] = await Promise.all([
    getRecoveryDashboardWindow(db, accountId, range, nowMs),
    range === "30d" ? Promise.resolve(null) : getRecoveryDashboardWindow(db, accountId, "30d", nowMs),
    getRecoveryStats(db, accountId, nowMs),
    getDashboardOnboardingProfile(db, accountId),
  ]);
  const data30d = data30dRaw ?? data;

  let roi: { thisMonth: RoiColumn; allTime: RoiColumn } | null = null;
  if (data.connection) {
    const now = new Date(nowMs);
    const firstOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // This month is every attributed recovery since the 1st, matured or not,
    // as Recova's column was; all time is what Foxhound bills (matured).
    const [thisMonth, allTime] = await Promise.all([
      listAttributedRecoveredSince(db, accountId, firstOfMonthUtc),
      listBillableRecoveredForRoi(db, accountId, nowMs, null),
    ]);
    roi = { thisMonth: roiColumn(thisMonth), allTime: roiColumn(allTime) };
  }

  const deliverability = await getDeliverabilityCounts(db, accountId, resolveRangeCutoff(range, nowMs).cutoffMs);

  const stepRows = await listStepsForFailedPayments(
    db,
    accountId,
    data.recentPayments.map((p) => p.id),
  );
  const paymentSteps: Record<string, PaymentStepSummary> = {};
  for (const p of data.recentPayments) {
    paymentSteps[p.id] = paymentStepSummary(
      stepRows.filter((s) => s.failedPaymentId === p.id),
      formatStepType,
    );
  }

  const onboarding = onboardingChecklistState(profile, Boolean(data.connection));
  // Recova's banner: connected, onboarding out of the way, and no failed
  // payment ever recorded (renewal noise excluded).
  const watchingForFailures = onboarding.connected && !onboarding.needed && lifetimeStats.totalFailedCount === 0;

  return {
    data,
    data30d,
    roi,
    onboarding,
    watchingForFailures,
    range,
    nowMs,
    queueHours: hoursFromMs(UPCOMING_STEPS_WINDOW_MS),
    paymentSteps,
    deliverability,
  };
}

// ---- Head ----

const WEBHOOK_TONE: Record<WebhookHealthTone, StatusTone> = {
  success: "ok",
  neutral: "info",
  failure: "crit",
};

function RangeSelector({ range }: { range: RecoveryRange }) {
  return (
    <TabsNav
      aria-label="Date range"
      size="sm"
      renderLink={({ href, ...props }) => <Link to={href} {...props} />}
    >
      {RECOVERY_RANGES.map((r) => (
        <TabLink key={r} href={`/recovery/dashboard?range=${r}`} current={range === r}>
          {r}
        </TabLink>
      ))}
    </TabsNav>
  );
}

// ---- Banners above the head (Recova's hasBanners block) ----

/** One row of a list that is read, not opened: Capsomer's row look without a
 *  link or button inside, because Capsomer's Row is always interactive (gap
 *  named in the J74 pull request). */
function StaticRow({
  title,
  detail,
  status,
  meta,
  actions,
}: {
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="cap-row" data-variant="outline">
      {status != null ? <span className="cap-row-status">{status}</span> : null}
      <div className="cap-row-title">{title}</div>
      {detail != null ? <p className="cap-row-detail">{detail}</p> : null}
      {meta != null ? <span className="cap-row-meta">{meta}</span> : null}
      {actions != null ? <div className="cap-row-actions">{actions}</div> : null}
    </li>
  );
}

function ChecklistStatus({ done }: { done: boolean }) {
  return done ? <Status tone="ok">Done</Status> : <Status tone="nodata">To do</Status>;
}

function OnboardingChecklist({ connected, senderNameSet, alertAddressSet }: OnboardingChecklistState) {
  const allDone = connected && senderNameSet && alertAddressSet;
  return (
    <Panel title="Getting started">
      <ul className="cap-rows" role="list" data-gap="sm">
        <StaticRow
          status={<ChecklistStatus done={connected} />}
          title="Connect Stripe"
          detail="Link your Stripe account so Foxhound can detect failed payments"
          actions={
            connected ? null : (
              <Link to="/connect" className="cap-btn" data-variant="primary" data-size="sm">
                Connect
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={senderNameSet} />}
          title="Set your sender name"
          detail="Customers will see this name in recovery emails"
          actions={
            senderNameSet ? null : (
              <Link to="/settings" className="cap-btn" data-size="sm">
                Go to settings
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={alertAddressSet} />}
          title="Set your notification email"
          detail="We'll send you an alert when a payment is recovered."
          actions={
            alertAddressSet ? null : (
              <Link to="/settings" className="cap-btn" data-size="sm">
                Go to settings
              </Link>
            )
          }
        />
        <StaticRow
          status={<ChecklistStatus done={allDone} />}
          title="You're ready"
          detail="Foxhound will automatically detect and recover failed payments"
        />
      </ul>
    </Panel>
  );
}

// ---- Stat cards ----

type Icon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

/** Recova's PrimaryCard and SecondaryCard: an icon, the label, the figure and
 *  an optional line under it, here as a small Capsomer panel (Capsomer's stat
 *  tile is always a link or a button, and Recova's cards lead nowhere). */
function StatCard({
  icon: IconComponent,
  label,
  value,
  sub,
  valueClassName,
  primary,
}: {
  icon: Icon;
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
  primary?: boolean;
}) {
  return (
    <Panel
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <IconComponent className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />
          {label}
        </span>
      }
    >
      <p
        className={`m-0 font-mono font-medium tabular-nums ${primary ? "text-display" : "text-title"} ${valueClassName ?? "text-text"}`}
      >
        {value}
      </p>
      {sub ? <p className="m-0 text-micro text-text-subtle">{sub}</p> : null}
    </Panel>
  );
}

function StatCardsPrimary({ w }: { w: RecoveryDashboardWindow }) {
  const atRiskPct = atRiskPctOfMrr(w.atRiskRevenue, w.connection?.mrrEstimateCents ?? null);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <StatCard primary icon={TrendingUp} label="Recovered (30d)" value={formatCurrencyTotals(w.recoveredRevenue)} />
      <StatCard
        primary
        icon={AlertCircle}
        label="Currently at risk"
        value={formatCurrencyTotals(w.atRiskRevenue)}
        sub={atRiskPct !== null ? `${atRiskPct}% of MRR` : undefined}
      />
      {/* A rate with nothing failed is no rate: Foxhound shows "-" and says
          why, where Recova printed 0% (RULES.md 2.1). */}
      <StatCard
        primary
        icon={Percent}
        label="Recovery rate"
        value={w.recoveryRatePct === null ? "-" : `${w.recoveryRatePct}%`}
        valueClassName={w.recoveryRatePct === null ? undefined : recoveryRateClassName(w.recoveryRatePct)}
        sub={recoveryRateBand(w.recoveryRatePct)}
      />
    </div>
  );
}

function StatCardsSecondary({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      <StatCard icon={Activity} label="Active sequences" value={String(w.activePaymentsCount)} />
      <StatCard icon={RefreshCw} label="Win-backs active" value={String(w.activeWinbacksCount)} />
      <StatCard icon={CreditCard} label="Cards expiring" value={String(w.expiringCardsCount)} />
      <StatCard
        icon={Clock}
        label="Avg days to recovery"
        value={w.avgDaysToRecovery === null ? "-" : `${w.avgDaysToRecovery}d`}
        sub={w.avgDaysToRecovery === null ? "No data" : `across ${w.recoveryDaysCount}`}
      />
      <StatCard
        icon={Tag}
        label="Best category"
        value={w.bestCategory ? DECLINE_CATEGORY_LABELS[w.bestCategory.cat] : "-"}
        sub={w.bestCategory ? `${w.bestCategory.rate}% recovery` : "Need more"}
      />
      <StatCard
        icon={Send}
        label="Emails sent"
        value={String(w.emailsSentInRange.sent)}
        sub={`${w.emailsSentInRange.openRatePct}% open · ${w.emailsSentInRange.clickRatePct}% click`}
      />
    </div>
  );
}

// ---- ROI widget ----

function RoiLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-label text-text-secondary">{label}</dt>
      <dd className={`m-0 font-mono text-body tabular-nums ${strong ? "font-semibold text-text" : "text-text-tertiary"}`}>
        {value}
      </dd>
    </div>
  );
}

/** Recova's ROIWidget, its two columns and six lines, on the figures Foxhound
 *  bills: attributed recoveries that have matured, with the fee from the
 *  pricing constant. Recova's "Recova fee (20%)" over every retry, click and
 *  manual recovery is the unratified claim not copied (ROWS-S S5, 181); the
 *  panel title says which recoveries these are, and "fees paid" became "fees",
 *  because Foxhound cannot know an invoice was paid from this page. */
function RoiWidget({ roi }: { roi: { thisMonth: RoiColumn; allTime: RoiColumn } }) {
  const empty = roi.thisMonth.recovered.length === 0 && roi.allTime.recovered.length === 0;
  return (
    <Panel
      title="Foxhound-attributed revenue"
      description={
        empty
          ? undefined
          : `Recoveries where a Foxhound action preceded payment. This month counts every attributed recovery since the 1st; all time counts those that have held for ${RECOVERY_MATURITY_DAYS} days, which are the ones Foxhound bills. Stripe's own recoveries are never billed.`
      }
    >
      {empty ? (
        <p className="m-0 text-label text-text-subtle">
          No attributed recoveries yet. Foxhound monitors every failed payment automatically.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">This month</h3>
            <dl className="m-0 flex flex-col gap-2">
              <RoiLine label="Recovered" value={formatCurrencyTotals(roi.thisMonth.recovered)} />
              <RoiLine
                label={`Foxhound fee (${RECOVERY_FEE_LABEL}, billed after ${RECOVERY_MATURITY_DAYS} days)`}
                value={formatCurrencyTotals(roi.thisMonth.fee)}
              />
              <RoiLine label="You keep" value={formatCurrencyTotals(roi.thisMonth.kept)} strong />
            </dl>
          </div>
          <div>
            <h3 className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">All time</h3>
            <dl className="m-0 flex flex-col gap-2">
              <RoiLine label="Total recovered" value={formatCurrencyTotals(roi.allTime.recovered)} />
              <RoiLine label="Total fees" value={formatCurrencyTotals(roi.allTime.fee)} />
              <RoiLine label="Net to you" value={formatCurrencyTotals(roi.allTime.kept)} strong />
            </dl>
          </div>
        </div>
      )}
    </Panel>
  );
}

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

function RecoveryRateChart({ w }: { w: RecoveryDashboardWindow }) {
  const title = `Recovery rate · ${w.rangeLabel}`;
  if (!w.recoveryRateDaily.some((p) => p.rate !== null)) {
    return (
      <Panel title={title}>
        <p className="m-0 text-label text-text-subtle">
          Not enough data yet. Recovery rate will appear after your first recovery.
        </p>
      </Panel>
    );
  }
  const rows = w.recoveryRateDaily.map((p) => ({ Day: p.date, rate: p.rate }));
  return (
    <Panel title={title}>
      <EnarratioFigure
        className="fh-recovery-chart"
        initialWidth={HALF_WIDTH}
        draw={(width) =>
          areaChart({
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
            width,
            height: RATE_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

function RevenueChart({ w, nowMs }: { w: RecoveryDashboardWindow; nowMs: number }) {
  // Recova's buildDailyChart: 7, 30 or 90 days, and 90 for all time.
  const days = w.rangeDays;
  const { rows, currencies } = dailyRecoveredRows(w.recoveredPayments, days, nowMs);
  const single = currencies.length === 1 ? currencies[0]! : null;
  return (
    <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-[2fr_1fr]">
      <Panel title={`Recovered revenue · ${w.rangeLabel}`} more={
        <span className="font-mono text-body font-semibold tabular-nums text-text">
          {formatCurrencyTotals(w.recoveredRevenue)}
        </span>
      }>
        <EnarratioFigure
          className="fh-recovery-chart"
          initialWidth={SIDE_WIDTH}
          draw={(width) =>
            barChart({
              data: rows,
              x: "Day",
              xType: "time",
              interval: "day",
              y: "amount",
              // One series per currency, only when there is more than one,
              // because a sum across currencies is meaningless (RULES.md 3.20).
              ...(single ? {} : { series: "currency" as const, layout: "grouped" as const }),
              colors: single ? { Recovered: "var(--green)" } : undefined,
              xLabel: null,
              yLabel: "Recovered",
              formatValue: (v) => (single ? formatMoney(Math.round(v * 100), single) : v.toFixed(2)),
              formatX: (d) => formatShortDate(d),
              maxXTicks: 4,
              alt: recoveredRevenueAlt(rows, days),
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

      {/* Recova's email side panel, labelled with the range as Recova's was.
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

function DeclineBreakdown({ w }: { w: RecoveryDashboardWindow }) {
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
                      // Enarratio's sparkline is an SVG named by its own
                      // generated sentence (count, first, last, lowest,
                      // highest), so the trend is text as well.
                      dangerouslySetInnerHTML={{
                        __html: withoutHoverTitles(
                          sparkline({
                            values: row.spark,
                            label: `${row.label} failures per day, last 30 days`,
                            width: 60,
                            height: 24,
                            endDot: false,
                          }),
                        ),
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

function EmailCategoryChart({ w }: { w: RecoveryDashboardWindow }) {
  const { rows, totalSent } = emailCategoryRows(w.emailCategoryPerformance);
  const title = "Email performance by decline type";
  if (totalSent === 0) {
    return (
      <Panel title={title}>
        <p className="m-0 text-label text-text-subtle">No recovery emails sent yet.</p>
      </Panel>
    );
  }
  return (
    <Panel title={title}>
      <EnarratioFigure
        className="fh-recovery-chart"
        initialWidth={SIDE_WIDTH}
        draw={(width) =>
          barChart({
            data: rows,
            x: "Category",
            y: "rate",
            series: "series",
            layout: "grouped",
            orientation: "horizontal",
            // Recova's legend order and colours: Open rate green, Click rate blue.
            seriesDomain: ["Open rate", "Click rate"],
            colors: { "Open rate": "var(--green)", "Click rate": "var(--blue)" },
            xLabel: null,
            yLabel: "Rate (%)",
            formatValue: pctText,
            alt: emailCategoryAlt(w.emailCategoryPerformance),
            width,
            height: EMAIL_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

function RecoveryTimingChart({ w }: { w: RecoveryDashboardWindow }) {
  const title = "When recoveries happen";
  const total = w.recoveryTimingBuckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return (
      <Panel title={title}>
        <p className="m-0 text-label text-text-subtle">No recoveries yet.</p>
      </Panel>
    );
  }
  // Recova draws the counts and prints each bar's share on top of it; the
  // share has the same shape, so it is what is drawn, against a % axis.
  const rows = w.recoveryTimingBuckets.map((b) => ({ Bucket: b.dayBucket, share: b.percentage }));
  return (
    <Panel title={title}>
      <EnarratioFigure
        className="fh-recovery-chart"
        initialWidth={HALF_WIDTH}
        draw={(width) =>
          barChart({
            data: rows,
            x: "Bucket",
            y: "share",
            xDomain: w.recoveryTimingBuckets.map((b) => b.dayBucket),
            colors: { "Share of recoveries (%)": "var(--green)" },
            xLabel: null,
            yLabel: "Share of recoveries (%)",
            formatValue: pctText,
            alt: recoveryTimingAlt(w.recoveryTimingBuckets),
            width,
            height: TIMING_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

// ---- Win-back, queue ----

function WinBackCard({ w }: { w: RecoveryDashboardWindow }) {
  return (
    <Panel title={`Win-back attribution · ${w.rangeLabel}`}>
      {w.reactivatedCount === 0 ? (
        <div>
          <p className="m-0 mb-3 text-label text-text-subtle">No reactivations yet</p>
          {/* Recova's sentence named a 90-day window its engine kept; Foxhound
              credits a reactivation to the win-back sequence named in the
              checkout the email's link opens, with no window
              (app/lib/recovery/winback-reactivation.server.ts). */}
          <p className="m-0 text-micro text-text-subtle">
            When a customer who cancelled reactivates their subscription from a win-back email, it appears here.
          </p>
        </div>
      ) : (
        <div>
          <p className="m-0 font-mono text-display font-semibold tabular-nums text-text">{w.reactivatedCount}</p>
          <p className="m-0 text-micro text-text-tertiary">
            customer{w.reactivatedCount !== 1 ? "s" : ""} reactivated
          </p>
          {w.reactivatedRevenue.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="m-0 text-micro text-text-tertiary">Monthly revenue recovered</p>
              <p className="m-0 font-mono text-title font-semibold tabular-nums text-text">
                {formatCurrencyTotals(w.reactivatedRevenue)}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function RecoveryQueue({ w, nowMs, hours }: { w: RecoveryDashboardWindow; nowMs: number; hours: number }) {
  if (w.upcomingSteps.length === 0) {
    return (
      <p className="m-0 px-1 py-3 text-label text-text-subtle">
        Nothing in the queue. All your recent payments came through clean.
      </p>
    );
  }
  return (
    <Panel title={`Recovery queue · next ${hours}h`}>
      <ul className="cap-rows" role="list" data-gap="xs">
        {w.upcomingSteps.map((s) => (
          <StaticRow
            key={s.id}
            title={s.customerName ?? s.customerEmail}
            detail={`${formatStepType(s.stepType)} · ${formatMoney(s.amountCents, s.currency)}`}
            meta={
              <span className="font-mono text-micro text-brand-text">
                {formatRelativeFuture(s.scheduledAt, nowMs) ?? formatTimestamp(s.scheduledAt)}
              </span>
            }
          />
        ))}
      </ul>
    </Panel>
  );
}

// ---- Failed payments ----

const PILL_TONE: Record<"success" | "failure" | "neutral", StatusTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

function DeliverabilityFigure({ value, label, small }: { value: string; label: string; small?: boolean }) {
  return (
    <p className="m-0">
      <span
        className={
          small
            ? "font-mono text-label tabular-nums text-text-subtle"
            : "font-mono text-title font-semibold tabular-nums text-text"
        }
      >
        {value}
      </span>{" "}
      <span className="text-micro text-text-tertiary">{label}</span>
    </p>
  );
}

/** Recova's DeliverabilityPanel (blob 87a88d88) on what Foxhound records.
 *  Recova's "delivered" figure and its alert are not shown: Foxhound stores no
 *  delivered event. Its empty state named Recova's old email provider; this
 *  one names Email Service. */
function DeliverabilityPanel({
  counts,
  rangeLabel,
}: {
  counts: { sent: number; bounced: number; complaints: number };
  rangeLabel: string;
}) {
  const f = deliverabilityFigures(counts);
  const rate = (pct: number | null) => (pct === null ? "-" : `${pct}%`);
  return (
    <div className="mb-5">
      <Panel title={`Email deliverability · ${rangeLabel}`}>
        {f === null ? (
          <p className="m-0 text-label text-text-subtle">
            No bounces or spam reports to show. Foxhound does not yet record them against the account that sent
            the email.
          </p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-6">
            <DeliverabilityFigure value={rate(f.bounceRatePct)} label="bounced" />
            <DeliverabilityFigure value={rate(f.spamRatePct)} label="spam" />
            <DeliverabilityFigure value={String(f.sent)} label="sent" small />
          </div>
        )}
      </Panel>
    </div>
  );
}

function PaymentsTable({
  w,
  steps,
  nowMs,
}: {
  w: RecoveryDashboardWindow;
  steps: Record<string, PaymentStepSummary>;
  nowMs: number;
}) {
  const payments = w.recentPayments;
  return (
    <Panel
      title="Failed payments"
      flush
      actions={
        <span className="flex items-center gap-4 text-label">
          {/* Recova counted "active" among the eight rows on show; this is
              every payment in recovery now, which is what the word claims. */}
          <span className="text-text-subtle">
            {w.totalFailedCount} total · {w.activePaymentsCount} active
          </span>
          <Link to="/recovery/payments" className="text-brand-text">
            View all
          </Link>
        </span>
      }
    >
      {payments.length === 0 ? (
        <Empty kind="nothing-yet" title="No failed payments yet" flush>
          Failed payments will appear here when detected.
        </Empty>
      ) : (
        <>
          {/* Recova's phone layout: one card per payment. */}
          <ul className="cap-rows sm:hidden" role="list">
            {payments.map((p) => (
              <StaticRow
                key={p.id}
                title={p.customerName ?? p.customerEmail}
                detail={
                  <span className="flex flex-wrap items-center gap-2">
                    <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                    <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                      {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                    </Pill>
                  </span>
                }
                meta={<span className="font-mono text-label text-text">{formatMoney(p.amountCents, p.currency)}</span>}
                actions={
                  <Link
                    to={`/recovery/payments/${p.id}`}
                    aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                    className="text-micro text-brand-text"
                  >
                    View
                  </Link>
                }
              />
            ))}
          </ul>

          <div className="hidden sm:block">
            <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Failed payments" tabIndex={0}>
              <table className="cap-table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Decline</th>
                    <th scope="col">Steps</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detected</th>
                    <th scope="col">
                      {/* Tailwind's sr-only, not cap-sr-only: that lives in
                          capsomer/base.css, which the merchant app does not
                          load (job_69b3fb23214b). */}
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const prior = priorFailureCount(w.previousFailureCounts[p.stripeCustomerId]);
                    const s = steps[p.id] ?? { completed: 0, total: 0, next: null };
                    return (
                      <tr key={p.id}>
                        <th scope="row">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-text">{p.customerName ?? p.customerEmail}</span>
                            {prior > 0 ? <Pill tone="warn">{prior + 1}x failure</Pill> : null}
                          </span>
                          {p.customerName ? (
                            <span className="block text-micro font-normal text-text-subtle">{p.customerEmail}</span>
                          ) : null}
                          {p.planName ? (
                            <span className="block text-micro font-normal text-text-subtle">{p.planName}</span>
                          ) : null}
                        </th>
                        <td className="whitespace-nowrap font-mono">{formatMoney(p.amountCents, p.currency)}</td>
                        <td>
                          <Pill variant="outline">{declineLabel(p.declineCategory)}</Pill>
                          {p.declineCode ? (
                            <span className="block font-mono text-micro text-text-subtle">{p.declineCode}</span>
                          ) : null}
                        </td>
                        <td>
                          <span className={`font-mono text-micro ${s.completed > 0 ? "text-text" : "text-text-subtle"}`}>
                            {s.completed}/{s.total}
                          </span>
                          {s.next ? <span className="block text-micro text-brand-text">Next: {s.next}</span> : null}
                        </td>
                        <td>
                          <Pill tone={PILL_TONE[failedPaymentStatusTone(p.status)]}>
                            {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                          </Pill>
                        </td>
                        <td className="whitespace-nowrap text-micro text-text-subtle">
                          <span className="block">{formatRelativeTime(p.detectedAt, nowMs)}</span>
                          <span className="block">{formatLongDate(p.detectedAt)}</span>
                        </td>
                        <td>
                          <Link
                            to={`/recovery/payments/${p.id}`}
                            aria-label={`View payment from ${p.customerName ?? p.customerEmail}`}
                            className="whitespace-nowrap text-micro text-brand-text"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---- Page ----

export default function RecoveryDashboard({ loaderData }: Route.ComponentProps) {
  const { data, data30d, roi, onboarding, watchingForFailures, range, nowMs, queueHours, paymentSteps, deliverability } =
    loaderData;
  const hasBanners = onboarding.needed || watchingForFailures;

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10, with
  // its banners above it in the same column. The shell owns the page's one
  // <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 pb-8 md:px-8 md:pb-10">
      {hasBanners ? (
        <div className="mt-6">
          {onboarding.needed ? (
            <OnboardingChecklist {...onboarding} />
          ) : null}
          {watchingForFailures ? (
            <Banner tone="neutral" title="We're watching for failed payments.">
              Stripe is connected. The first failed renewal or one-time charge will appear here within minutes of
              the decline. No action needed until then.
            </Banner>
          ) : null}
        </div>
      ) : null}

      <div className="mb-7 pt-8 md:pt-10">
        <PageHead
          title="Dashboard"
          lead={
            data.connection
              ? `Connected · ${data.connection.name ?? data.connection.stripeUserId}`
              : "No Stripe account connected"
          }
          actions={
            data.connection ? (
              <div className="flex flex-col items-end gap-1.5">
                <RangeSelector range={range} />
                {data.webhookHealth ? (
                  <Status tone={WEBHOOK_TONE[data.webhookHealth.tone]}>{data.webhookHealth.label}</Status>
                ) : null}
                {data.lastRecoveryAgo ? (
                  <p className="m-0 text-micro text-text-subtle">
                    Last recovery <span className="text-success-text">{data.lastRecoveryAgo}</span>
                  </p>
                ) : null}
              </div>
            ) : null
          }
        />
      </div>

      {/* ROW 1: primary stat cards, always 30 days. */}
      <div className="mb-5">
        <StatCardsPrimary w={data30d} />
      </div>

      {/* ROW 2: ROI widget. */}
      {roi ? (
        <div className="mb-5">
          <RoiWidget roi={roi} />
        </div>
      ) : null}

      {/* ROW 3: the time series, on the selected range. */}
      <div className="mb-5 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <RecoveryRateChart w={data} />
        <RevenueChart w={data} nowMs={nowMs} />
      </div>

      {/* ROW 4: decline analysis, 3/2. */}
      <div className="mb-5">
        <p className="m-0 mb-3 text-micro font-medium uppercase tracking-wide text-text-tertiary">Decline analysis</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <div className="min-w-0 md:col-span-3">
            <DeclineBreakdown w={data} />
          </div>
          <div className="min-w-0 md:col-span-2">
            <EmailCategoryChart w={data} />
          </div>
        </div>
      </div>

      {/* ROW 5: timing (always 30 days) beside win-back (the range). */}
      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <RecoveryTimingChart w={data30d} />
        <WinBackCard w={data} />
      </div>

      {/* ROW 6: the recovery queue. */}
      <div className="mb-5">
        <RecoveryQueue w={data} nowMs={nowMs} hours={queueHours} />
      </div>

      {/* ROW 7: secondary stat cards, always 30 days. */}
      <div className="mb-5">
        <StatCardsSecondary w={data30d} />
      </div>

      {/* ROW 8: email deliverability (range-controlled). */}
      <DeliverabilityPanel counts={deliverability} rangeLabel={data.rangeLabel} />

      {/* ROW 9: failed payments. */}
      <PaymentsTable w={data} steps={paymentSteps} nowMs={nowMs} />
      <div className="mt-3 text-right">
        <Link to="/recovery/payments" aria-label="View all failed payments" className="text-label text-brand-text">
          View all payments <ArrowRight className="inline-block" size={13} strokeWidth={1.5} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
