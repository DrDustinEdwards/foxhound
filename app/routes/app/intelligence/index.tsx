import { Icon, iconChevronLeft, iconChevronRight } from "capsomer/react/icons";
import { formatCount } from "@drdustinedwards/site-helpers/text";
import { useCallback, useMemo, useState } from "react";
import { data, useFetcher } from "react-router";
import { Link } from "capsomer/react/link";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { type ChartFit, ChartPanel } from "capsomer/react/chart-frame";
import { Meter } from "capsomer/react/meter";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import "capsomer/meter.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";

import "~/components/charts.css";
import { getDb } from "~/db";
import { accountScope } from "~/lib/auth/context";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import {
  GENERATE_REPORT_ERROR_STATUS,
  dayOverDayCents,
  firstSnapshotSentence,
  monthLabel,
  narrativeErrorMessage,
  newMrrMonthToDateCents,
  planBreakdownRows,
  sampleEveryNth,
  shiftMonth,
  signedMoney,
  weeklyMovements,
  type GenerateReportError,
} from "~/lib/intelligence/dashboard";
import { monthKey } from "@dustinedwards/site-runtime/time";
import {
  drawHealth,
  drawMovement,
  drawMrrTrend,
  drawNrr,
  drawPlans,
} from "~/lib/intelligence/dashboard-charts";
import { healthScoreMeterTone } from "~/lib/intelligence/health-band";
import { generateMonthlyReport } from "~/lib/intelligence/report-generate.server";
import { getIntelligenceOverview, getReportsArchive } from "~/lib/intelligence/views.server";
import { getHealthDistribution, getMrrSnapshotSeries } from "~/lib/intelligence/trends.server";
import { formatMoney, formatMoneyShort, toMajorUnits } from "@dustinedwards/site-runtime/money";

import type { Route } from "./+types/index";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /intelligence/dashboard: the head, four stat cards, the MRR trend, NRR, MRR movement, MRR by plan, customer health distribution, then the monthly summary with its month pager and Generate/Regenerate button. With no snapshot yet, a syncing card stands in for all of it. Charts are Enarratio's. Snapshots come from intelligence-sync, which runs daily, so the series is ninety days of daily rows (trends.server.ts). The movement chart sums each week (dashboard.ts weeklyMovements). The narrative is a template written from the engine's facts with no model call (narrative.ts), through report-generate.server.ts. The "Most at-risk customers" table is Foxhound's own, held for Dustin, kept after the summary.

export function meta() {
  return [{ title: "Intelligence - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { auth, db, accountId } = accountScope(context);

  const nowMs = Date.now();
  const [overview, healthDistribution, mrrSeries, archive] = await Promise.all([
    getIntelligenceOverview(db, accountId),
    getHealthDistribution(db, accountId, nowMs),
    getMrrSnapshotSeries(db, accountId, nowMs),
    getReportsArchive(db, accountId),
  ]);
  return {
    overview,
    healthDistribution,
    mrrSeries,
    reports: archive.map((r) => ({ month: monthKey(r.reportMonth), narrative: r.narrative })),
    currentMonth: monthKey(new Date(nowMs)),
    nowMs,
    isDemo: auth.isDemo,
  };
}

type ActionResult =
  | { ok: true; month: string; narrative: string }
  | { ok: false; error: GenerateReportError };

/** A refusal, with the status that says what it is. */
function refused(error: GenerateReportError) {
  return data<ActionResult>({ ok: false, error }, { status: GENERATE_REPORT_ERROR_STATUS[error] });
}

/** The Generate report button. The account is the session's, never the form's; the demo never reaches here. */
export async function action({ context, request }: Route.ActionArgs) {
  const { env, auth, accountId } = accountScope(context);
  // The demo firewall already refuses every non-GET; this keeps the action
  // safe on its own.
  if (auth.isDemo) return refused("demo_read_only");

  // Everything below, reads and the report write included, is caught: a thrown error would reach the route's error boundary and replace the whole dashboard, where the card shows "Could not generate the report. Try again or contact support."
  try {
    const db = getDb(env);
    const form = await readForm(request, BODY_MAX_BYTES);
    if (form.get("intent") !== "generate") return refused("invalid_intent");
    const result = await generateMonthlyReport(
      env,
      db,
      accountId,
      String(form.get("month") ?? ""),
      Date.now(),
    );
    if (!result.ok) return refused(result.error);
    return data<ActionResult>(result, { status: 200 });
  } catch (err) {
    console.error(`intelligence report action failed for account ${accountId}:`, err);
    return refused("server_error");
  }
}

export default function IntelligenceDashboardPage({ loaderData }: Route.ComponentProps) {
  const { overview, healthDistribution, mrrSeries, reports, currentMonth, nowMs, isDemo } =
    loaderData;
  const latest = mrrSeries[mrrSeries.length - 1];

  // max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10. The shell owns the page's one <main>, so this is a plain wrapper.
  return (
    <div className="fh-intel-page-tall cap-admin-page" data-width="page">
      <div className="fh-intel-head">
        <PageHead title="Dashboard" />
      </div>

      {!latest ? (
        // The card is a line and two sentences, not a heading, so it is a plain Capsomer panel body rather than Empty (whose title would be a heading).
        <div className="cap-panel">
          <div className="cap-panel-body fh-center">
            <p className="fh-body fh-medium fh-text">Syncing your MRR data</p>
            <p className="fh-small fh-quiet">{firstSnapshotSentence()}</p>
          </div>
        </div>
      ) : (
        <div className="fh-intel-stack">
          <StatCards series={mrrSeries} latest={latest} nowMs={nowMs} />
          <MrrTrend series={mrrSeries} currency={latest.currency} />
          <NrrCard series={mrrSeries} />
          <MovementCard series={mrrSeries} currency={latest.currency} />
          <PlanCard perPlan={latest.perPlanBreakdown} currency={latest.currency} />
          <HealthCard days={healthDistribution} />
          <MonthlySummary reports={reports} currentMonth={currentMonth} isDemo={isDemo} />
        </div>
      )}

      {overview.topAtRisk.length > 0 ? (
        <section className="fh-intel-section">
          <p className="fh-mono fh-tiny fh-quiet fh-caps">Most at-risk customers</p>
          <div className="fh-intel-table-wrap">
            <table className="fh-intel-table fh-left fh-small">
              <thead>
                <tr className="fh-intel-table-head fh-tiny fh-quiet fh-caps">
                  <th className="fh-intel-cell fh-regular">Customer</th>
                  <th className="fh-intel-cell fh-regular">Health</th>
                  <th className="fh-intel-cell fh-regular">MRR</th>
                </tr>
              </thead>
              <tbody>
                {overview.topAtRisk.map((c) => (
                  <tr key={c.stripeCustomerId} className="fh-intel-row">
                    <td className="fh-intel-cell">
                      <Link
                        to={`/intelligence/customers/${c.stripeCustomerId}`}
                        className="fh-intel-name fh-text"
                      >
                        {c.customerName ?? c.stripeCustomerId}
                      </Link>
                    </td>
                    <td className="fh-intel-cell-bar">
                      <Meter
                        label={<span className="cap-sr-only">Health score</span>}
                        size="sm"
                        value={c.healthScore}
                        max={100}
                        display={c.healthScore}
                        tone={healthScoreMeterTone(c.healthScore)}
                        valueText={`Health score ${c.healthScore} of 100.`}
                      />
                    </td>
                    <td className="fh-intel-cell fh-mono fh-text">
                      {formatMoney(c.mrrContributionCents, overview.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

type Series = Route.ComponentProps["loaderData"]["mrrSeries"];
type Latest = Series[number];

/** MRR, Day-over-day, Active customers, New MRR (MTD), two across on a phone and four from md. Day-over-day is the latest snapshot less the one before, green up and red down, "--" when flat or with one snapshot; a fall carries a minus. A figure that leads nowhere is plain text in a panel, not a Capsomer stat tile (which is always a link or a button), as on the churn page's band cards. */
function StatCards({ series, latest, nowMs }: { series: Series; latest: Latest; nowMs: number }) {
  const delta = dayOverDayCents(series);
  const deltaClass = !delta ? "fh-quiet" : delta > 0 ? "fh-success" : "fh-error";
  const figure = "fh-mono fh-title fh-bold cap-num";
  return (
    <div className="fh-intel-tiles">
      <Panel title="MRR" size="sm">
        <p className={`${figure} fh-brand`}>
          {formatMoneyShort(latest.totalMrrCents, latest.currency)}
        </p>
      </Panel>
      <Panel title="Day-over-day" size="sm">
        <p className={`${figure} ${deltaClass}`}>
          {delta ? signedMoney(delta, latest.currency) : "--"}
        </p>
      </Panel>
      <Panel title="Active customers" size="sm">
        <p className={`${figure} fh-text`}>{formatCount(latest.activeCustomersCount)}</p>
      </Panel>
      <Panel title="New MRR (MTD)" size="sm">
        <p className={`${figure} fh-success`}>
          {formatMoneyShort(newMrrMonthToDateCents(series, nowMs), latest.currency)}
        </p>
      </Panel>
    </div>
  );
}

/** Total MRR, every daily snapshot of the 90 days. */
function MrrTrend({ series, currency }: { series: Series; currency: string }) {
  const draw = useCallback(
    (w: number, fit: ChartFit) => drawMrrTrend(series, currency, w, fit),
    [series, currency],
  );
  return <ChartPanel title="MRR trend (90 days)" draw={draw} />;
}

/** NRR: every 7th daily snapshot, withheld until some snapshot carries a positive retention figure. Single series, so no legend. */
function NrrCard({ series }: { series: Series }) {
  const sampled = useMemo(() => sampleEveryNth(series), [series]);
  const draw = useCallback((w: number, fit: ChartFit) => drawNrr(sampled, w, fit), [sampled]);
  if (!series.some((p) => (p.nrrPct ?? 0) > 0)) return null;
  return <ChartPanel title="Net Revenue Retention (90 days)" draw={draw} />;
}

/** MRR movement: five series, stacked, gated on any non-zero movement, one bar per week of summed daily movement. */
function MovementCard({ series, currency }: { series: Series; currency: string }) {
  const weeks = useMemo(() => weeklyMovements(series), [series]);
  const draw = useCallback(
    (w: number, fit: ChartFit) => drawMovement(weeks, currency, w, fit),
    [weeks, currency],
  );
  const moved = weeks.some(
    (p) =>
      Math.round(toMajorUnits(p.newMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.expansionMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.reactivationMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.contractionMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.churnMrrCents, currency)) !== 0,
  );
  if (!moved) return null;
  return <ChartPanel title="MRR movement" draw={draw} />;
}

/** MRR by plan: the latest snapshot's MRR per plan, largest first, drawn as Enarratio bars. The snapshot keeps MRR per plan and no customer count (buildPlanBreakdown), so no count is shown. */
function PlanCard({ perPlan, currency }: { perPlan: unknown; currency: string }) {
  const rows = useMemo(() => planBreakdownRows(perPlan), [perPlan]);
  const draw = useCallback(
    (w: number, fit: ChartFit) => drawPlans(rows, currency, w, fit),
    [rows, currency],
  );
  if (rows.length === 0) return null;
  return <ChartPanel title="MRR by plan" gridlines="x" draw={draw} />;
}

/** Customers per band per sampled day over 90 days (intelligence-ai is daily, so the window is true here), in Foxhound's bands (healthScoreBand). */
function HealthCard({ days }: { days: Route.ComponentProps["loaderData"]["healthDistribution"] }) {
  const draw = useCallback((w: number, fit: ChartFit) => drawHealth(days, w, fit), [days]);
  if (days.length === 0) return null;
  return <ChartPanel title="Customer health distribution" draw={draw} />;
}

/**
 * The monthly narrative: a month pager, a Generate or Regenerate button, and the month's report, or a line saying there is none. Reports come from the loader and the button posts to this route's action. Every failure is said in the card.
 * The button shows for the current month only: the narrative is written from today's facts, so a past month's report cannot be generated honestly, and a control that cannot do its job is left out. In the demo the button answers with the demo's read-only sentence instead of posting.
 */
function MonthlySummary({
  reports,
  currentMonth,
  isDemo,
}: {
  reports: { month: string; narrative: string }[];
  currentMonth: string;
  isDemo: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const [month, setMonth] = useState(currentMonth);
  const [submittedMonth, setSubmittedMonth] = useState<string | null>(null);
  const [demoRefused, setDemoRefused] = useState(false);
  const cache = useMemo(() => new Map(reports.map((r) => [r.month, r.narrative])), [reports]);

  const loading = fetcher.state !== "idle";
  const result = !loading && submittedMonth === month ? fetcher.data : undefined;
  const narrative = (result?.ok ? result.narrative : null) ?? cache.get(month) ?? null;
  const error =
    demoRefused || (result && !result.ok && result.error === "demo_read_only")
      ? DEMO_READ_ONLY_MESSAGE
      : result && !result.ok
        ? narrativeErrorMessage(result.error)
        : null;
  const canGenerate = month === currentMonth;

  function go(delta: number) {
    setMonth(shiftMonth(month, delta));
    setSubmittedMonth(null);
    setDemoRefused(false);
  }

  function generate() {
    if (isDemo) {
      setDemoRefused(true);
      return;
    }
    setSubmittedMonth(month);
    void fetcher.submit({ intent: "generate", month }, { method: "post" });
  }

  const label = monthLabel(month);
  return (
    <Panel
      title="Monthly summary"
      actions={
        <span className="cap-cluster" data-gap="4">
          <span className="fh-intel-month">
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              label="Previous month"
              onClick={() => go(-1)}
            >
              <Icon d={iconChevronLeft} className="fh-icon-16" />
            </Button>
            <span className="fh-intel-month-label fh-center fh-mono fh-small fh-text">{label}</span>
            <Button variant="quiet" size="sm" iconOnly label="Next month" onClick={() => go(1)}>
              <Icon d={iconChevronRight} className="fh-icon-16" />
            </Button>
          </span>
          {canGenerate ? (
            <Button variant="primary" size="sm" pending={loading} onClick={generate}>
              {loading ? "Generating..." : narrative ? "Regenerate report" : "Generate report"}
            </Button>
          ) : null}
        </span>
      }
    >
      <div aria-live="polite">
        {loading ? (
          <p className="fh-small fh-quiet">Generating your monthly summary...</p>
        ) : error ? (
          <p className="fh-small fh-error">{error}</p>
        ) : narrative ? (
          <p className="fh-pre-wrap fh-small fh-relaxed fh-text">{narrative}</p>
        ) : canGenerate ? (
          <p className="fh-small fh-quiet">
            No report yet for {label}. Click Generate report to create one.
          </p>
        ) : (
          <p className="fh-small fh-quiet">No report for {label}.</p>
        )}
      </div>
    </Panel>
  );
}
