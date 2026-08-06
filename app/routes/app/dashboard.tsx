import { BarChart, CohortGrid, LineArea, isCohortRows } from "~/components/charts";
import {
  ConsoleAttentionFeed,
  ConsoleHeroRow,
  ConsoleTileRow,
} from "~/components/console-panels";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { getConsoleView } from "~/lib/dashboard/console.server";
import { getMrrAnalytics, getRecoveryStats } from "~/lib/dashboard/stats.server";
import { recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/dashboard";

export function meta() {
  return [{ title: "Dashboard - Foxhound" }];
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

  // The console's "Platform health" is handed the rate getRecoveryStats already
  // computed rather than deriving its own. Legacy recomputed a lifetime rate here
  // with different filters, so the same account showed two different recovery
  // rates on adjacent screens.
  const consoleView = await getConsoleView(db, accountId, nowMs, stats.recoveryRatePct);

  return { stats, mrr, consoleView, nowMs };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { stats, mrr, consoleView, nowMs } = loaderData;
  const revenue = stats.revenueRecovered[0] ?? null;
  const billable = stats.billableRevenue[0] ?? null;
  const fee = stats.feeOwed[0] ?? null;
  const rawCohorts = mrr.latest?.perCohortBreakdown;
  const cohortRows = isCohortRows(rawCohorts) ? rawCohorts : [];

  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 py-8 md:py-10">
      {/* Ruling 147 f1-f3, legacy app/(app)/console/page.tsx: the <main> there is
      max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10. max-w-6xl was 1152px,
      128px short, and px-4/py-8 never took legacy's md step. */}
      <h1 className="text-title font-medium text-text">Dashboard</h1>

      <div className="mt-6">
        <ConsoleHeroRow hero={consoleView.hero} />
      </div>

      <div className="mt-4">
        <ConsoleTileRow tiles={consoleView.tiles} nowMs={nowMs} />
      </div>

      <ConsoleAttentionFeed
        rows={consoleView.attention}
        currency={consoleView.hero.protectedCurrency}
      />

      <section className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Revenue recovered"
          value={revenue ? formatMoney(revenue.cents, revenue.currency) : "$0.00"}
        />
        <StatCard
          label="Recovery rate"
          value={stats.recoveryRatePct === null ? "--" : `${stats.recoveryRatePct}%`}
          valueClassName={
            stats.recoveryRatePct === null ? undefined : recoveryRateClassName(stats.recoveryRatePct)
          }
          subtext={
            stats.totalFailedCount === 0
              ? "No failed payments yet"
              : `${stats.recoveredCount} of ${stats.totalFailedCount} recovered`
          }
        />
        <StatCard
          label="Failed payments"
          value={String(stats.activeFailedCount)}
          subtext="Currently in recovery"
        />
        <StatCard
          label="Fee owed"
          value={fee ? formatMoney(fee.cents, fee.currency) : "$0.00"}
          subtext={
            fee && billable
              ? `20% of ${formatMoney(billable.cents, billable.currency)} recovered`
              : "Nothing billable yet"
          }
        />
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-title font-medium text-text">MRR analytics</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Free
          </span>
        </div>

        {mrr.latest ? (
          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                MRR trend
              </p>
              <p className="mt-1 font-mono text-title text-text">
                {formatMoney(mrr.latest.totalMrrCents, mrr.latest.currency)}
              </p>
              <div className="mt-3 text-blue">
                <LineArea
                  points={mrr.trend.map((s) => ({
                    label: `${s.snapshotDate.getUTCMonth() + 1}/${s.snapshotDate.getUTCFullYear() % 100}`,
                    value: s.totalMrrCents / 100,
                  }))}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Movements (latest month)
              </p>
              <div className="mt-3">
                <BarChart
                  data={[
                    { label: "New", value: mrr.latest.newMrrCents / 100 },
                    { label: "Expand", value: mrr.latest.expansionMrrCents / 100 },
                    { label: "Contract", value: -mrr.latest.contractionMrrCents / 100 },
                    { label: "Churn", value: -mrr.latest.churnMrrCents / 100 },
                    { label: "Reactivate", value: mrr.latest.reactivationMrrCents / 100 },
                  ]}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Churn rate
              </p>
              <p className="mt-1 font-mono text-title text-text">
                {((mrr.latest.voluntaryChurnRateBps ?? 0) / 100).toFixed(1)}% voluntary,{" "}
                {((mrr.latest.involuntaryChurnRateBps ?? 0) / 100).toFixed(1)}% involuntary
              </p>
            </div>

            {cohortRows.length > 0 ? (
              <div className="rounded-lg border border-border bg-surface p-4">
                <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  Cohorts
                </p>
                <div className="mt-3">
                  <CohortGrid rows={cohortRows} />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
            No MRR data yet. Analytics populate once Foxhound has tracked a full billing cycle for
            this account.
          </p>
        )}
      </section>
    </div>
  );
}
