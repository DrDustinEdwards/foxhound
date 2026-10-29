import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "./recovery/dashboard.css";

import { ConsoleAttentionFeed, ConsoleHeroRow, ConsoleTileRow } from "~/components/console-panels";
import { EnarratioFigure } from "~/components/enarratio-figure";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { mrrEmptySentence } from "~/lib/dashboard/console";
import { drawCohorts, drawLatestMovement } from "~/lib/dashboard/console-charts";
import { getConsoleView } from "~/lib/dashboard/console.server";
import { formatCurrencyTotals, RECOVERY_FEE_LABEL } from "~/lib/dashboard/recovery-dashboard";
import { recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { getMrrAnalytics, getRecoveryStats } from "~/lib/dashboard/stats.server";
import { drawMrrTrend } from "~/lib/intelligence/dashboard-charts";
import { firstSnapshotSentence } from "~/lib/intelligence/dashboard";
import { isCohortRows } from "~/lib/intelligence/mrr";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/dashboard";

// /console (row S2, job J64). Recova is the spec: app/(app)/console/page.tsx
// at blob 3b8a736e, lib/console-data.tsx at 234791c4 and lib/products.ts at
// 6be24574, each read whole. In Recova's order and width (max-w-[1280px],
// px-4 md:px-8, py-8 md:py-10): the "Console" heading, the hero row of three
// platform figures, the four product tiles, then the needs-attention rows or
// Recova's "All clear. The platform is running." Recova's "Platform working
// together" block is not built: its three sentences claim cooperation between
// products that Foxhound's engine does not perform (ROWS-S S2, frozen into 20d).
//
// Built from Capsomer 0.9.0's parts (Q10), charts by Enarratio (Q1), amber
// throughout. The numbers are Foxhound's engine, never Recova's: money
// per currency through groupSumByCurrency (RULES.md 3.20), and the recovery
// rate the one getRecoveryStats computes over every failure by the date it
// failed (APPROVED-DIFFERENCES, "Recovery rate statistics count by the date a
// payment failed").
//
// Below Recova's content sit two Foxhound sections Recova's console does not
// have: the four recovery stat cards and the free MRR analytics (PRICING.md:
// basic MRR analytics are free for every Recovery merchant, and this is the
// only page that shows them to an account without Intelligence). Both are
// kept as they were, restyled on Capsomer, and named in the J64 pull request
// for Dustin's word.

export function meta() {
  return [{ title: "Console - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const nowMs = Date.now();
  const [stats, mrr] = await Promise.all([
    getRecoveryStats(db, accountId, nowMs),
    getMrrAnalytics(db, accountId),
  ]);

  // "Platform health" is handed the rate getRecoveryStats already computed
  // rather than deriving its own. Recova recomputed a lifetime rate here with
  // different filters, so the same account showed two different recovery
  // rates on adjacent screens.
  const consoleView = await getConsoleView(db, accountId, nowMs, stats.recoveryRatePct);

  return { stats, mrr, consoleView, nowMs };
}

function StatPanel({
  label,
  value,
  valueClassName,
  sub,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  sub?: string;
}) {
  return (
    <Panel size="sm" title={label}>
      <p className={`m-0 font-mono text-display font-medium tabular-nums ${valueClassName ?? "text-text"}`}>{value}</p>
      {sub ? <p className="m-0 mt-1 text-label text-text-subtle">{sub}</p> : null}
    </Panel>
  );
}

export default function Console({ loaderData }: Route.ComponentProps) {
  const { stats, mrr, consoleView, nowMs } = loaderData;
  const latest = mrr.latest;
  const rawCohorts = latest?.perCohortBreakdown;
  const cohortRows = isCohortRows(rawCohorts) ? rawCohorts : [];
  const trend = mrr.trend.map((s) => ({ at: new Date(s.snapshotDate), totalMrrCents: s.totalMrrCents }));

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-10">
      <div className="mb-6">
        <PageHead title="Console" />
      </div>

      <ConsoleHeroRow hero={consoleView.hero} />
      <ConsoleTileRow tiles={consoleView.tiles} nowMs={nowMs} />
      <ConsoleAttentionFeed rows={consoleView.attention} />

      <section className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Recovery figures">
        <StatPanel label="Revenue recovered" value={formatCurrencyTotals(stats.revenueRecovered)} />
        <StatPanel
          label="Recovery rate"
          value={stats.recoveryRatePct === null ? "-" : `${stats.recoveryRatePct}%`}
          valueClassName={stats.recoveryRatePct === null ? undefined : recoveryRateClassName(stats.recoveryRatePct)}
          sub={
            stats.totalFailedCount === 0
              ? "No failed payments yet"
              : `${stats.recoveredCount} of ${stats.totalFailedCount} recovered`
          }
        />
        <StatPanel label="Failed payments" value={String(stats.activeFailedCount)} sub="Currently in recovery" />
        <StatPanel
          label="Fee owed"
          value={formatCurrencyTotals(stats.feeOwed)}
          sub={
            stats.feeOwed.length > 0 && stats.billableRevenue.length > 0
              ? `${RECOVERY_FEE_LABEL} of ${formatCurrencyTotals(stats.billableRevenue)} recovered`
              : "Nothing billable yet"
          }
        />
      </section>

      <section className="mt-10" aria-labelledby="mrr-analytics">
        <h2 id="mrr-analytics" className="m-0 text-title font-medium text-text">
          MRR analytics
        </h2>

        {latest ? (
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel
              title="MRR trend"
              level={3}
              more={
                <span className="font-mono text-body font-medium tabular-nums text-text">
                  {formatMoney(latest.totalMrrCents, latest.currency)}
                </span>
              }
            >
              <EnarratioFigure
                className="fh-recovery-chart"
                initialWidth={560}
                draw={(width) => drawMrrTrend(trend, latest.currency, width)}
              />
            </Panel>

            <Panel title="Movements (latest month)" level={3}>
              <EnarratioFigure
                className="fh-recovery-chart"
                initialWidth={560}
                draw={(width) => drawLatestMovement(latest, latest.currency, width)}
              />
            </Panel>

            <Panel title="Churn rate" level={3}>
              <p className="m-0 font-mono text-title tabular-nums text-text">
                {((latest.voluntaryChurnRateBps ?? 0) / 100).toFixed(1)}% voluntary,{" "}
                {((latest.involuntaryChurnRateBps ?? 0) / 100).toFixed(1)}% involuntary
              </p>
            </Panel>

            {cohortRows.length > 0 ? (
              <Panel title="Cohorts" level={3}>
                <EnarratioFigure
                  className="fh-recovery-chart"
                  initialWidth={560}
                  draw={(width) => drawCohorts(cohortRows, width)}
                />
              </Panel>
            ) : null}
          </div>
        ) : (
          <div className="mt-4">
            {/* Foxhound's intelligence-sync writes the first MRR snapshot on its
                monthly run, but only for an account with Stripe connected that
                is neither paused nor canceled. Only that account is promised
                a date; the others are told why none is coming. */}
            <Empty kind="nothing-yet" title="No MRR data yet">
              {mrrEmptySentence(consoleView.mrrSync, firstSnapshotSentence(nowMs))}
            </Empty>
          </div>
        )}
      </section>
    </div>
  );
}
