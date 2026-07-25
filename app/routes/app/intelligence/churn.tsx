import { Link } from "react-router";

import { MultiLine } from "~/components/charts";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { formatDateShort } from "~/lib/date-format";
import { healthScoreClassName, WATCH_CEILING, type HealthScoreBand } from "~/lib/intelligence/health-band";
import { churnBandSharePct } from "~/lib/intelligence/churn";
import { getChurnView, isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";

import type { Route } from "./+types/churn";

// /intelligence/churn (ROUTES.md rev 4 restored this surface; legacy parity
// source app/intelligence/demo/churn/page.tsx plus the fuller authed
// app/(app)/intelligence/churn/page.tsx). MRR split across the three health
// bands, the highest-value at-risk customers, and involuntary vs voluntary
// churn over time.

export function meta() {
  return [{ title: "Churn risk - Foxhound" }];
}

const BAND_ORDER: HealthScoreBand[] = ["at_risk", "watch", "healthy"];

const BAND_LABEL: Record<HealthScoreBand, string> = {
  at_risk: "High risk",
  watch: "Medium risk",
  healthy: "Healthy",
};

// Derived from the real thresholds rather than written out, so a threshold
// change cannot leave the card captions claiming the old bands.
const BAND_RANGE_LABEL: Record<HealthScoreBand, string> = {
  at_risk: `Health 0-${HEALTH_SCORE_AT_RISK_THRESHOLD - 1}`,
  watch: `Health ${HEALTH_SCORE_AT_RISK_THRESHOLD}-${WATCH_CEILING - 1}`,
  healthy: `Health ${WATCH_CEILING}-100`,
};

const BAND_BORDER_CLASS: Record<HealthScoreBand, string> = {
  at_risk: "border-error-border",
  watch: "border-amber-border",
  healthy: "border-success-border",
};

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const entitled = await isIntelligenceEntitled(db, accountId);
  if (!entitled) return { entitled: false as const };

  const view = await getChurnView(db, accountId, Date.now());
  return { entitled: true as const, view };
}

export default function IntelligenceChurn({ loaderData }: Route.ComponentProps) {
  if (!loaderData.entitled) return <IntelligenceUpsell />;
  const { view } = loaderData;
  const currency = "usd";

  const byBand = new Map(view.bands.map((b) => [b.band, b]));
  const hasRateData = view.ratePoints.some(
    (p) => (p.voluntaryPct ?? 0) > 0 || (p.involuntaryPct ?? 0) > 0,
  );

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
      <header className="mb-6">
        <h1 className="m-0 mb-1 text-title font-semibold text-text">Churn risk</h1>
        <p className="m-0 text-label text-text-tertiary">MRR at risk by customer health band.</p>
      </header>

      {/* Rendered whenever it has data, independently of whether any customer is
          scored yet: the rate series comes from mrr_snapshots, a different table,
          so gating it on the scored-customer count would withhold real history
          for an unrelated reason. */}
      {hasRateData ? (
        <section className="mb-6 rounded-lg border border-border bg-surface p-4">
          <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">
            Churn rate over time
          </h2>
          <p className="m-0 mt-1 text-label text-text-tertiary">
            Involuntary churn (payment failures) against voluntary churn (cancellations).
          </p>
          <div className="mt-3">
            <MultiLine
              labels={view.ratePoints.map((p) => formatDateShort(p.at))}
              yTickFormat={(v) => `${Math.round(v * 10) / 10}%`}
              series={[
                {
                  name: "Involuntary",
                  colorClassName: "text-red",
                  values: view.ratePoints.map((p) => p.involuntaryPct),
                },
                {
                  name: "Voluntary",
                  colorClassName: "text-text-tertiary",
                  dashed: true,
                  values: view.ratePoints.map((p) => p.voluntaryPct),
                },
              ]}
            />
          </div>
        </section>
      ) : null}

      {view.scoredCustomerCount === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-10 text-center">
          <h2 className="m-0 text-body font-medium text-text">Health scores are being calculated.</h2>
          <p className="m-0 mx-auto mt-2 max-w-[420px] text-label leading-relaxed text-text-tertiary">
            Check back after the next Intelligence sync.
          </p>
        </section>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            {BAND_ORDER.map((band) => {
              const row = byBand.get(band) ?? { band, customerCount: 0, mrrCents: 0 };
              return (
                <div
                  key={band}
                  className={`rounded-lg border bg-surface p-4 ${BAND_BORDER_CLASS[band]}`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                      {BAND_LABEL[band]}
                    </span>
                    <span className="font-mono text-micro uppercase tracking-wide text-text-subtle">
                      {BAND_RANGE_LABEL[band]}
                    </span>
                  </div>
                  <p className="m-0 mt-2 font-mono text-display font-medium tabular-nums text-text">
                    {formatMoney(row.mrrCents, currency)}
                  </p>
                  <p className="m-0 mt-1 text-label text-text-tertiary">
                    {row.customerCount} {row.customerCount === 1 ? "customer" : "customers"} ·{" "}
                    {churnBandSharePct(row.mrrCents, view.scoredMrrCents)}% of scored MRR
                  </p>
                </div>
              );
            })}
          </div>

          {view.topHighRisk.length > 0 ? (
            <section className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h2 className="m-0 text-label font-semibold text-text">High-risk customers by MRR</h2>
                <p className="m-0 mt-1 text-micro text-text-tertiary">
                  Top {view.topHighRisk.length} in the high-risk band, sorted by monthly contribution.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-label">
                  <thead>
                    <tr className="border-b border-border text-left text-text-tertiary">
                      <th className="px-4 py-2 font-mono text-micro font-medium uppercase tracking-wide">
                        Customer
                      </th>
                      <th className="px-3 py-2 font-mono text-micro font-medium uppercase tracking-wide">
                        Plan
                      </th>
                      <th className="px-3 py-2 text-right font-mono text-micro font-medium uppercase tracking-wide">
                        Health
                      </th>
                      <th className="px-3 py-2 text-right font-mono text-micro font-medium uppercase tracking-wide">
                        MRR
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.topHighRisk.map((row) => (
                      <tr key={row.stripeCustomerId} className="border-t border-border">
                        <td className="px-4 py-3">
                          <Link
                            to={`/intelligence/customers/${row.stripeCustomerId}`}
                            className="text-text no-underline hover:text-amber-text"
                          >
                            <span className="block font-medium">{row.customerName ?? "(unnamed)"}</span>
                            <span className="block font-mono text-micro text-text-subtle">
                              {row.stripeCustomerId}
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-text-tertiary">{row.currentPlanName ?? "-"}</td>
                        {/* Toned from the score rather than hardcoded red: the query
                            pre-filters to the high-risk band today, but a widened
                            predicate should not leave the color lying. */}
                        <td
                          className={`px-3 py-3 text-right font-mono font-semibold ${healthScoreClassName(row.healthScore)}`}
                        >
                          {row.healthScore}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-text">
                          {row.mrrContributionCents > 0
                            ? formatMoneyShort(row.mrrContributionCents, currency)
                            : "-"}
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
