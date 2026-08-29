import { Link } from "react-router";

import { BarChart, Meter } from "~/components/charts";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { healthScoreMeterTone } from "~/lib/intelligence/health-band";
import { getIntelligenceOverview, isIntelligenceEntitled } from "~/lib/intelligence/views.server";
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

  const overview = await getIntelligenceOverview(db, accountId);
  return { entitled: true as const, overview };
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

  const { overview } = loaderData;
  const { scoreDistribution } = overview;

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

          <section className="mt-8">
            <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              Score distribution
            </p>
            <div className="mt-3 rounded-lg border border-border bg-surface p-4">
              <BarChart
                data={[
                  { label: "Healthy", value: scoreDistribution.healthy, tone: "positive" },
                  { label: "Watch", value: scoreDistribution.watch, tone: "neutral" },
                  { label: "At risk", value: scoreDistribution.atRisk, tone: "negative" },
                ]}
              />
            </div>
          </section>

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
