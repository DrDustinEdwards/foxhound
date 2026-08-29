import { Link } from "react-router";

import { Meter, MultiLine, StackedBars } from "~/components/charts";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatDateMonthDay } from "~/lib/date-format";
import { healthScoreMeterTone } from "~/lib/intelligence/health-band";
import {
  getHealthDistribution,
  getIntelligenceOverview,
  getMrrSnapshotSeries,
  isIntelligenceEntitled,
} from "~/lib/intelligence/views.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Intelligence - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const entitled = await isIntelligenceEntitled(db, accountId);
  if (!entitled) return { entitled: false as const };

  const nowMs = Date.now();
  const [overview, healthDistribution, mrrSeries] = await Promise.all([
    getIntelligenceOverview(db, accountId),
    getHealthDistribution(db, accountId, nowMs),
    getMrrSnapshotSeries(db, accountId, nowMs),
  ]);
  return { entitled: true as const, overview, healthDistribution, mrrSeries };
}

export default function IntelligenceOverviewPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.entitled) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-title font-medium text-text">Intelligence</h1>
        <IntelligenceUpsell />
      </div>
    );
  }

  const { overview, healthDistribution, mrrSeries } = loaderData;
  const { scoreDistribution } = overview;

  // Legacy gates the NRR card on any snapshot carrying a positive retention
  // figure, so an account that has never had a prior period to retain against
  // gets no empty frame (NRRChart.tsx:15).
  const hasNrr = mrrSeries.some((p) => (p.nrrPct ?? 0) > 0);
  const mrrLabels = mrrSeries.map((p) => formatDateMonthDay(p.at));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-title font-medium text-text">Intelligence</h1>

      {overview.scoredCustomerCount === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No customers scored yet. Once Stripe has synced and the nightly Intelligence run
          completes, risk scores and MRR-at-risk exposure will appear here.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="MRR at risk"
              value={formatMoney(overview.mrrAtRiskCents, overview.currency)}
              subtext={`${overview.atRiskCustomerCount} customer(s)`}
            />
            <StatCard label="Customers scored" value={String(overview.scoredCustomerCount)} />
            <StatCard
              label="Score distribution"
              value={`${scoreDistribution.healthy} / ${scoreDistribution.watch} / ${scoreDistribution.atRisk}`}
              subtext="Healthy / Watch / At risk"
            />
          </section>

          {/* Legacy's NRRChart, built (ruling 399: an element the 394 walk never
              saw, because legacy's demo twin does not render it; the real page
              mounts it at app/(app)/intelligence/dashboard/page.tsx:11, between
              the MRR trend and the MRR movement charts). Source read whole at
              app/(app)/intelligence/dashboard/components/NRRChart.tsx.

              Legacy's own copy, with its window replaced by Foxhound's real one
              under 78/79: legacy says "(90 days)" against a daily snapshot job,
              and intelligence-sync is monthly here, so ninety days would be
              three points and the sentence would misdescribe our own data. Same
              correction the churn chart shipped at 384c0db.

              Single series, so no legend: legacy renders no Legend on this
              chart. The dashed rule at 100 is legacy's ReferenceLine. */}
          {hasNrr && mrrLabels.length > 1 ? (
            <section className="mt-8 rounded-[12px] border border-border bg-surface px-6 py-5">
              <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Net Revenue Retention
              </h2>
              <p className="m-0 mt-1 text-label text-text-tertiary">
                Above 100% means expansion exceeds churn, last 12 months
              </p>
              <div className="mt-4">
                <MultiLine
                  height={140}
                  showLegend={false}
                  referenceValue={100}
                  labels={mrrLabels}
                  yTickFormat={(v) => `${Math.round(v * 10) / 10}%`}
                  series={[
                    {
                      name: "NRR",
                      colorClassName: "text-blue",
                      values: mrrSeries.map((p) => p.nrrPct),
                    },
                  ]}
                />
              </div>
            </section>
          ) : null}

          {/* Legacy's HealthDistributionChart, ported (ruling 399: the 394 walk
              called this an addition against the demo twin, and legacy's REAL
              dashboard renders it, so the owed work is ALIGNMENT toward
              app/(app)/intelligence/dashboard/components/HealthDistributionChart.tsx).

              What changed: the card used to plot a single snapshot of today's
              three band counts as three bars. Legacy plots the counts as a
              STACKED TIME SERIES, one stack per sampled day across the window,
              which is a different chart answering a different question (how the
              book of customers is moving, not where it stands tonight).

              Shell, eyebrow and sub are legacy's, with its raw type values
              mapped onto Foxhound's tokens rather than ported literally,
              because 179/187 freeze the type scale in BOTH directions. Same
              treatment the churn chart shipped with at 384c0db.

              Bands are Foxhound's (78/79), see getHealthDistribution. */}
          {healthDistribution.length > 0 ? (
            <section className="mt-8 rounded-[12px] border border-border bg-surface px-6 py-5">
              <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Customer health distribution
              </h2>
              <p className="m-0 mt-1 text-label text-text-tertiary">
                Customer count per health band over 90 days
              </p>
              <div className="mt-4">
                <StackedBars
                  height={200}
                  labels={healthDistribution.map((d) =>
                    formatDateMonthDay(new Date(`${d.date}T00:00:00Z`)),
                  )}
                  series={[
                    {
                      name: "High risk",
                      colorClassName: "text-red",
                      values: healthDistribution.map((d) => d.atRisk),
                    },
                    {
                      name: "Medium risk",
                      colorClassName: "text-amber",
                      values: healthDistribution.map((d) => d.watch),
                    },
                    {
                      name: "Healthy",
                      colorClassName: "text-green",
                      values: healthDistribution.map((d) => d.healthy),
                    },
                  ]}
                />
              </div>
            </section>
          ) : null}

          <section className="mt-8">
            <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              This month's narrative
            </p>
            <div className="mt-3 rounded-[12px] border border-border bg-surface px-6 py-5">
              {overview.narrative ? (
                <>
                  <p className="text-body text-text">{overview.narrative}</p>
                  {overview.narrativeGeneratedAt ? (
                    <p className="mt-2 text-micro text-text-subtle">
                      Generated {overview.narrativeGeneratedAt.toLocaleDateString()}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-body text-text-tertiary">
                  No narrative yet. The nightly Intelligence run generates one once there is
                  enough data.
                </p>
              )}
            </div>
          </section>

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
                            className="text-text hover:text-amber"
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
        </>
      )}
    </div>
  );
}
