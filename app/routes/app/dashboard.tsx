import { ChartPanel } from "capsomer/react/chart-frame";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { StaticStatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/stat-tile.css";

import { ConsoleAttentionFeed, ConsoleHeroRow, ConsoleTileRow } from "~/components/console-panels";
import "~/components/charts.css";
import { accountScope } from "~/lib/auth/context";
import { drawCohorts, drawLatestMovement } from "~/lib/dashboard/console-charts";
import { mrrEmptySentence } from "~/lib/dashboard/console";
import { getConsoleView } from "~/lib/dashboard/console.server";
import { RECOVERY_FEE_LABEL } from "~/lib/dashboard/recovery-dashboard";
import { formatAmounts } from "~/lib/money/totals";
import { recoveryRateStatusTone } from "~/lib/dashboard/recovery-rate";
import { getMrrAnalytics, getRecoveryStats } from "~/lib/dashboard/stats.server";
import { firstSnapshotSentence } from "~/lib/intelligence/dashboard";
import { drawMrrTrend } from "~/lib/intelligence/dashboard-charts";
import { isCohortRows } from "~/lib/intelligence/mrr";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import type { Route } from "./+types/dashboard";
import { NOINDEX } from "~/lib/seo/meta";

// /console: the "Console" heading, the hero row of three platform figures, the four product tiles, then the needs-attention rows or "All clear. The platform is running." in a 1280px column. The numbers are Foxhound's engine: money per currency through groupSumByCurrency, and the recovery rate the one getRecoveryStats computes over every failure by the date it failed.
// Below sit two further sections: the four recovery stat cards and the free MRR analytics (PRICING.md: basic MRR analytics are free for every Recovery merchant, and this is the only page that shows them to an account without Intelligence).

export function meta() {
  return [{ title: "Console - Foxhound" }, NOINDEX];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);

  const nowMs = Date.now();
  const [stats, mrr] = await Promise.all([
    getRecoveryStats(db, accountId, nowMs),
    getMrrAnalytics(db, accountId),
  ]);

  // "Platform health" is handed the rate getRecoveryStats already computed rather than deriving its own, so adjacent screens never show two different recovery rates.
  const consoleView = await getConsoleView(db, accountId, nowMs, stats.recoveryRatePct);

  return { stats, mrr, consoleView, nowMs };
}

export default function Console({ loaderData }: Route.ComponentProps) {
  const { stats, mrr, consoleView, nowMs } = loaderData;
  const latest = mrr.latest;
  const rawCohorts = latest?.perCohortBreakdown;
  const cohortRows = isCohortRows(rawCohorts) ? rawCohorts : [];
  const trend = mrr.trend.map((s) => ({
    at: new Date(s.snapshotDate),
    totalMrrCents: s.totalMrrCents,
  }));

  return (
    <div className="fh-console cap-admin-page" data-width="page">
      <div className="fh-console-head">
        <PageHead title="Console" />
      </div>

      <ConsoleHeroRow hero={consoleView.hero} />
      <ConsoleTileRow tiles={consoleView.tiles} nowMs={nowMs} />
      <ConsoleAttentionFeed rows={consoleView.attention} />

      <div className="fh-console-section">
        <StatTiles layout="grid" label="Recovery figures">
          <StaticStatTile
            label="Revenue recovered"
            figure={formatAmounts(stats.revenueRecovered)}
          />
          <StaticStatTile
            label="Recovery rate"
            figure={stats.recoveryRatePct === null ? "-" : `${stats.recoveryRatePct}%`}
            tone={
              stats.recoveryRatePct === null
                ? undefined
                : recoveryRateStatusTone(stats.recoveryRatePct)
            }
            detail={
              stats.totalFailedCount === 0
                ? "No failed payments yet"
                : `${stats.recoveredCount} of ${stats.totalFailedCount} recovered`
            }
          />
          <StaticStatTile
            label="Failed payments"
            figure={stats.activeFailedCount}
            detail="Currently in recovery"
          />
          <StaticStatTile
            label="Fee owed"
            figure={formatAmounts(stats.feeOwed)}
            detail={
              stats.feeOwed.length > 0 && stats.billableRevenue.length > 0
                ? `${RECOVERY_FEE_LABEL} of ${formatAmounts(stats.billableRevenue)} recovered`
                : "Nothing billable yet"
            }
          />
        </StatTiles>
      </div>

      <section className="fh-console-section" aria-labelledby="mrr-analytics">
        <h2 id="mrr-analytics" className="fh-title fh-medium fh-text">
          MRR analytics
        </h2>

        {latest ? (
          <div className="fh-console-charts">
            <ChartPanel
              title="MRR trend"
              level={3}
              more={
                <span className="fh-mono fh-body fh-medium cap-num fh-text">
                  {formatMoney(latest.totalMrrCents, latest.currency)}
                </span>
              }
              gridlines="none"
              width={560}
              draw={(width, fit) => drawMrrTrend(trend, latest.currency, width, fit)}
            />

            <ChartPanel
              title="Movements (latest month)"
              level={3}
              gridlines="none"
              width={560}
              draw={(width, fit) => drawLatestMovement(latest, latest.currency, width, fit)}
            />

            <Panel title="Churn rate" level={3}>
              <p className="fh-mono fh-title cap-num fh-text">
                {((latest.voluntaryChurnRateBps ?? 0) / 100).toFixed(1)}% voluntary,{" "}
                {((latest.involuntaryChurnRateBps ?? 0) / 100).toFixed(1)}% involuntary
              </p>
            </Panel>

            {cohortRows.length > 0 ? (
              <ChartPanel
                title="Cohorts"
                level={3}
                gridlines="none"
                width={560}
                draw={(width, fit) => drawCohorts(cohortRows, width, fit)}
              />
            ) : null}
          </div>
        ) : (
          <div className="fh-console-more">
            {/* Foxhound's intelligence-sync writes the first MRR snapshot on its
                daily run, but only for an account with Stripe connected that
                is neither paused nor canceled. Only that account is promised
                a date; the others are told why none is coming. */}
            <Empty
              kind="nothing-yet"
              title={mrrEmptySentence(consoleView.mrrSync, firstSnapshotSentence())}
            />
          </div>
        )}
      </section>
    </div>
  );
}
