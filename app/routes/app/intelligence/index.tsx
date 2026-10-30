import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { data, Link, useFetcher } from "react-router";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";

import { Meter } from "~/components/charts";
import { EnarratioFigure } from "~/components/enarratio-figure";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/session";
import {
  GENERATE_REPORT_ERROR_STATUS,
  dayOverDayCents,
  firstSnapshotSentence,
  monthKeyOf,
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
import { formatMoney, formatMoneyShort, toMajorUnits } from "~/lib/money-format";

import type { Route } from "./+types/index";
import { NOINDEX } from "~/lib/seo/meta";

// /intelligence/dashboard (row S16, job J67). Recova is the spec: its real
// page, app/(app)/intelligence/dashboard/page.tsx at blob cbe7e8fe, and the
// seven components it mounts, each read whole (MRRStatCards 2920fa3b,
// MRRTrendChart c7a0da3f, NRRChart b07e9de3, MRRMovementChart 3c94525e,
// PlanBreakdown 65b5674f, HealthDistributionChart cd7dd675, MonthlyNarrative
// 791e2f5f). In Recova's order and width: the head, four stat cards, the MRR
// trend, NRR, MRR movement, MRR by plan, customer health distribution, then
// the monthly summary with its month pager and Generate/Regenerate button. With
// no snapshot yet, Recova's syncing card stands in for all of it.
//
// Built from Capsomer 0.9.0's parts (Q10), charts by Enarratio (Q1), amber
// throughout. No Foxhound CSS sits over a Capsomer component: Recova's
// 12px card radius, its uppercase eyebrow labels and its stat figure colors
// wait for Capsomer's per-site layer (capsomer job_ec5ec0754626), listed in
// the J67 pull request.
//
// Foxhound's engine, never Recova's (78/79): snapshots come from
// intelligence-sync, which runs daily as Recova's job did, so the series is
// Recova's ninety days of daily rows (trends.server.ts). The movement chart
// sums each week, where Recova drew every 7th day under a "by week" caption
// (a truthfulness fix, dashboard.ts weeklyMovements). The
// narrative is Foxhound's (narrative.ts), a template written from the
// engine's facts with no model call, through report-generate.server.ts.
//
// The "Most at-risk customers" table is Foxhound's own and HELD for Dustin
// (TASK-seven-walked-pages.md): it is kept exactly as it was, after the summary.

export function meta() {
  return [{ title: "Intelligence - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

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
    reports: archive.map((r) => ({ month: monthKeyOf(r.reportMonth), narrative: r.narrative })),
    currentMonth: monthKeyOf(new Date(nowMs)),
    nowMs,
    isDemo: auth.isDemo,
  };
}

type ActionResult = { ok: true; month: string; narrative: string } | { ok: false; error: GenerateReportError };

/** A refusal, with the status that says what it is. */
function refused(error: GenerateReportError) {
  return data<ActionResult>({ ok: false, error }, { status: GENERATE_REPORT_ERROR_STATUS[error] });
}

/** Recova's Generate report button. The account is the session's, never the
 *  form's (RULES.md 4.6); the demo never reaches here (RULES.md 4.12). */
export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  // The demo firewall already refuses every non-GET; this keeps the action
  // safe on its own.
  if (auth.isDemo) return refused("demo_read_only");

  // Everything below, reads and the report write included, is caught: a
  // thrown error would reach the route's error boundary and replace the whole
  // dashboard, where Recova's card showed its server-500 sentence, "Could not
  // generate the report. Try again or contact support."
  try {
    const db = getDb(env);
    const form = await request.formData();
    if (form.get("intent") !== "generate") return refused("invalid_intent");
    const result = await generateMonthlyReport(env, db, accountId, String(form.get("month") ?? ""), Date.now());
    if (!result.ok) return refused(result.error);
    return data<ActionResult>(result, { status: 200 });
  } catch (err) {
    console.error(`intelligence report action failed for account ${accountId}:`, err);
    return refused("server_error");
  }
}

export default function IntelligenceDashboardPage({ loaderData }: Route.ComponentProps) {
  const { overview, healthDistribution, mrrSeries, reports, currentMonth, nowMs, isDemo } = loaderData;
  const latest = mrrSeries[mrrSeries.length - 1];

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10. The
  // shell owns the page's one <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-10">
      <div className="mb-6">
        <PageHead title="Dashboard" lead="MRR trends and customer health" />
      </div>

      {!latest ? (
        // Recova's card is a line and two sentences, not a heading, so it is
        // a plain Capsomer panel body rather than Empty (whose title would be
        // a heading Recova does not have).
        <div className="cap-panel">
          <div className="cap-panel-body text-center">
            <p className="m-0 text-body font-medium text-text">Syncing your MRR data</p>
            <p className="m-0 text-label text-text-tertiary">{firstSnapshotSentence()}</p>
            <p className="m-0 text-label text-text-tertiary">
              While you wait, walk through your recovery sequences or review any open disputes.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
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
        <section className="mt-8">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Most at-risk customers
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-3 font-normal">Customer</th>
                  <th className="px-4 py-3 font-normal">Health</th>
                  <th className="px-4 py-3 font-normal">MRR</th>
                </tr>
              </thead>
              <tbody>
                {overview.topAtRisk.map((c) => (
                  <tr key={c.stripeCustomerId} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        to={`/intelligence/customers/${c.stripeCustomerId}`}
                        className="text-text hover:text-brand-text"
                      >
                        {c.customerName ?? c.stripeCustomerId}
                      </Link>
                    </td>
                    <td className="w-40 px-4 py-3">
                      <Meter
                        value={c.healthScore}
                        tone={healthScoreMeterTone(c.healthScore)}
                        label={`Health score ${c.healthScore} of 100`}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-text">
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

/**
 * Recova's MRRStatCards: MRR, Day-over-day, Active customers, New MRR (MTD),
 * two across on a phone and four from md, in Recova's colors. Day-over-day is
 * the latest snapshot less the one before, green up and red down, "--" when
 * flat or with one snapshot, as Recova drew it; its fall carries a minus, where
 * Recova printed the bare amount (truthfulness). A figure that leads nowhere
 * is plain text in a panel, not a Capsomer stat tile (which is always a link
 * or a button), the same choice as the churn page's band cards.
 */
function StatCards({ series, latest, nowMs }: { series: Series; latest: Latest; nowMs: number }) {
  const delta = dayOverDayCents(series);
  const deltaClass = !delta ? "text-text-tertiary" : delta > 0 ? "text-success-text" : "text-error-text";
  const figure = "m-0 font-mono text-title font-bold tabular-nums";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Panel title="MRR" size="sm">
        <p className={`${figure} text-brand-text`}>{formatMoneyShort(latest.totalMrrCents, latest.currency)}</p>
      </Panel>
      <Panel title="Day-over-day" size="sm">
        <p className={`${figure} ${deltaClass}`}>{delta ? signedMoney(delta, latest.currency) : "--"}</p>
      </Panel>
      <Panel title="Active customers" size="sm">
        <p className={`${figure} text-text`}>{latest.activeCustomersCount.toLocaleString("en-US")}</p>
      </Panel>
      <Panel title="New MRR (MTD)" size="sm">
        <p className={`${figure} text-success-text`}>
          {formatMoneyShort(newMrrMonthToDateCents(series, nowMs), latest.currency)}
        </p>
      </Panel>
    </div>
  );
}

/** Recova's MRRTrendChart: total MRR, every daily snapshot of the 90 days. */
function MrrTrend({ series, currency }: { series: Series; currency: string }) {
  const draw = useCallback((w: number) => drawMrrTrend(series, currency, w), [series, currency]);
  return (
    <Panel title="MRR trend (90 days)">
      <EnarratioFigure draw={draw} />
    </Panel>
  );
}

/** Recova's NRRChart: every 7th daily snapshot, withheld (as Recova withholds
 *  it) until some snapshot carries a positive retention figure. Single
 *  series, so no legend. */
function NrrCard({ series }: { series: Series }) {
  const sampled = useMemo(() => sampleEveryNth(series), [series]);
  const draw = useCallback((w: number) => drawNrr(sampled, w), [sampled]);
  if (!series.some((p) => (p.nrrPct ?? 0) > 0)) return null;
  return (
    <Panel title="Net Revenue Retention" description="Above 100% means expansion exceeds churn (90 days)">
      <EnarratioFigure draw={draw} />
    </Panel>
  );
}

/** Recova's MRRMovementChart: its five series, its stacking and its gate on any
 *  non-zero movement, one bar per week of summed daily movement. */
function MovementCard({ series, currency }: { series: Series; currency: string }) {
  const weeks = useMemo(() => weeklyMovements(series), [series]);
  const draw = useCallback((w: number) => drawMovement(weeks, currency, w), [weeks, currency]);
  const moved = weeks.some(
    (p) =>
      Math.round(toMajorUnits(p.newMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.expansionMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.reactivationMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.contractionMrrCents, currency)) !== 0 ||
      Math.round(toMajorUnits(p.churnMrrCents, currency)) !== 0,
  );
  if (!moved) return null;
  return (
    <Panel title="MRR movement" description="New, expansion, contraction, and churn by week">
      <EnarratioFigure draw={draw} />
    </Panel>
  );
}

/**
 * Recova's PlanBreakdown: the latest snapshot's MRR per plan, largest first,
 * drawn as Enarratio bars. Recova also printed each plan's customer count;
 * Foxhound's snapshot keeps MRR per plan and no count (buildPlanBreakdown), so
 * no count is shown rather than one computed some other way.
 */
function PlanCard({ perPlan, currency }: { perPlan: unknown; currency: string }) {
  const rows = useMemo(() => planBreakdownRows(perPlan), [perPlan]);
  const draw = useCallback((w: number) => drawPlans(rows, currency, w), [rows, currency]);
  if (rows.length === 0) return null;
  return (
    <Panel title="MRR by plan">
      <EnarratioFigure draw={draw} />
    </Panel>
  );
}

/** Recova's HealthDistributionChart: customers per band per sampled day over
 *  90 days (intelligence-ai is daily, so the window is true here), in
 *  Foxhound's bands (healthScoreBand, 78/79). */
function HealthCard({ days }: { days: Route.ComponentProps["loaderData"]["healthDistribution"] }) {
  const draw = useCallback((w: number) => drawHealth(days, w), [days]);
  if (days.length === 0) return null;
  return (
    <Panel title="Customer health distribution" description="Customer count per health band over 90 days">
      <EnarratioFigure draw={draw} />
    </Panel>
  );
}

/**
 * Recova's MonthlyNarrative: a month pager, a Generate or Regenerate button,
 * and the month's report, or a line saying there is none. Reports come from
 * the loader (Recova's local cache of twelve months) and the button posts to
 * this route's action. Every failure is said in the card, Recova's words where
 * Recova had them.
 *
 * The button shows for the current month only. Foxhound's narrative is written
 * from today's facts, so a past month's report cannot be generated honestly,
 * and a control that cannot do its job is left out (RULES.md 2.7). In the demo
 * the button answers with the demo's read-only sentence instead of posting.
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
        <span className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1">
            <Button variant="quiet" size="sm" iconOnly label="Previous month" onClick={() => go(-1)}>
              <ChevronLeft aria-hidden="true" size={16} />
            </Button>
            <span className="min-w-[120px] text-center font-mono text-label text-text">{label}</span>
            <Button variant="quiet" size="sm" iconOnly label="Next month" onClick={() => go(1)}>
              <ChevronRight aria-hidden="true" size={16} />
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
          <p className="m-0 text-label text-text-tertiary">Generating your monthly summary...</p>
        ) : error ? (
          <p className="m-0 text-label text-error-text">{error}</p>
        ) : narrative ? (
          <p className="m-0 whitespace-pre-wrap text-label leading-relaxed text-text">{narrative}</p>
        ) : canGenerate ? (
          <p className="m-0 text-label text-text-tertiary">
            No report yet for {label}. Click Generate report to create one.
          </p>
        ) : (
          <p className="m-0 text-label text-text-tertiary">No report for {label}.</p>
        )}
      </div>
    </Panel>
  );
}
