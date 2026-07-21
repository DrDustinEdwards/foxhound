import { Meter, Sparkline } from "~/components/charts";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { healthScoreClassName, healthScoreMeterTone } from "~/lib/intelligence/health-band";
import { getCustomerHealthDetail, isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/customer";

export function meta() {
  return [{ title: "Customer health - Foxhound" }];
}

// Account-scoped by construction: getCustomerHealthDetail's query carries
// BOTH accountId and the requested stripeCustomerId in one predicate, so a
// customer belonging to another account resolves to null (404), never a
// cross-tenant read (the account-scoping audit flagged this route by name).
export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const entitled = await isIntelligenceEntitled(db, accountId);
  if (!entitled) return { entitled: false as const };

  const detail = await getCustomerHealthDetail(db, accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return { entitled: true as const, detail };
}

export default function CustomerHealthPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.entitled) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-title font-medium text-text">Customer health</h1>
        <IntelligenceUpsell />
      </div>
    );
  }

  const { detail } = loaderData;
  const factors = detail.healthFactors;
  const historyOldestFirst = [...detail.history].reverse();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-title font-medium text-text">
        {detail.customerName ?? detail.customerEmail ?? detail.stripeCustomerId}
      </h1>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="MRR contribution" value={formatMoney(detail.mrrContributionCents, detail.currency)} />
        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Health score</p>
          {detail.healthScore === null ? (
            <p className="mt-2 text-body text-text-tertiary">Not scored yet.</p>
          ) : (
            <>
              <p className={`mt-2 font-mono text-display font-medium ${healthScoreClassName(detail.healthScore)}`}>
                {detail.healthScore}/100
              </p>
              <div className="mt-2">
                <Meter
                  value={detail.healthScore}
                  tone={healthScoreMeterTone(detail.healthScore)}
                  label={`Health score ${detail.healthScore} of 100`}
                />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="mt-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Factors</p>
        {factors.length === 0 ? (
          <p className="mt-2 text-body text-text-tertiary">
            No factors moved this score away from the baseline.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {factors.map((f) => (
              <li
                key={f.signal}
                className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-3"
              >
                <span className="text-label text-text">{f.detail}</span>
                <span
                  className={`font-mono text-label ${f.deltaPoints < 0 ? "text-error-text" : "text-success-text"}`}
                >
                  {f.deltaPoints > 0 ? "+" : ""}
                  {f.deltaPoints}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">AI assessment</p>
        <div className="mt-3 rounded-lg border border-border bg-surface p-4">
          {detail.aiAssessment ? (
            <>
              <p className="text-body text-text">{detail.aiAssessment}</p>
              {detail.aiAssessmentGeneratedAt ? (
                <p className="mt-2 text-micro text-text-subtle">
                  Generated {detail.aiAssessmentGeneratedAt.toLocaleDateString()}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-body text-text-tertiary">
              No AI assessment yet for this customer.
            </p>
          )}
        </div>
      </section>

      {historyOldestFirst.length >= 2 ? (
        <section className="mt-8">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Score history</p>
          <div className="mt-3 rounded-lg border border-border bg-surface p-4 text-blue">
            <Sparkline values={historyOldestFirst.map((h) => h.healthScore)} width={480} height={60} />
          </div>
        </section>
      ) : null}

      {detail.predictions.length > 0 ? (
        <section className="mt-8">
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Predictions</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-label">
              <thead>
                <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-3 font-normal">Predicted</th>
                  <th className="px-4 py-3 font-normal">Score</th>
                  <th className="px-4 py-3 font-normal">Horizon</th>
                  <th className="px-4 py-3 font-normal">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {detail.predictions.map((p, i) => (
                  <tr key={i} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3 text-text-tertiary">{p.predictedAt.toLocaleDateString()}</td>
                    <td className="px-4 py-3 font-mono text-text">{p.score}</td>
                    <td className="px-4 py-3 text-text-tertiary">{p.horizonDays}d</td>
                    <td className="px-4 py-3 text-text-tertiary">{p.realizedOutcome ?? "pending"}</td>
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
