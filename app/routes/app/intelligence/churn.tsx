import { plural } from "@drdustinedwards/site-helpers/text";
import { percent } from "capsomer/behavior/meter";
import { Table } from "capsomer/react/table";
import { Link } from "capsomer/react/link";
import { ChartFrame } from "capsomer/react/chart-frame";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";

import "~/components/charts.css";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { authContext } from "~/lib/auth/context";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import {
  healthScoreClassName,
  WATCH_CEILING,
  type HealthScoreBand,
} from "~/lib/intelligence/health-band";
import { drawChurnRate, type ChurnRatePointLike } from "~/lib/intelligence/churn";
import { getChurnView } from "~/lib/intelligence/trends.server";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import type { Route } from "./+types/churn";
import { NOINDEX } from "~/lib/seo/meta";

// /intelligence/churn. Recova is the spec: its real page,
// app/(app)/intelligence/churn/page.tsx at blob 718cd7f5, and its chart,
// app/(app)/intelligence/churn/components/ChurnRateChart.tsx at blob f4b9d3e5,
// both read whole. In Recova's order and width: the head, the churn-rate chart,
// the three band cards, then the high-risk customers table; or, when nobody is
// scored yet, Recova's "being calculated" card in place of the bands and table.
//
// Built from Capsomer 0.9.0's parts with the chart drawn by Enarratio,
// amber throughout. No Foxhound CSS sits over a Capsomer component:
// Recova's band tints, its pill colors per plan and its 12px radius wait for
// Capsomer's per-site layer, listed in the J29
// notes. Band cutoffs are Foxhound's engine (40/70, rulings 78/79), derived
// from the constants below, never Recova's 33/66.

export function meta() {
  return [{ title: "Churn Risk - Foxhound" }, NOINDEX];
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

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const view = await getChurnView(db, accountId, Date.now());
  return { view };
}

export default function IntelligenceChurn({ loaderData }: Route.ComponentProps) {
  const { view } = loaderData;
  const currency = "usd";

  const byBand = new Map(view.bands.map((b) => [b.band, b]));
  // Recova's ChurnRateChart returns null unless some rate is above zero.
  const hasRateData = view.ratePoints.some(
    (p) => (p.voluntaryPct ?? 0) > 0 || (p.involuntaryPct ?? 0) > 0,
  );

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8. The shell owns
  // the page's one <main>, so this is a plain wrapper.
  return (
    <div className="fh-intel-page cap-admin-page" data-width="page">
      <div className="fh-intel-head">
        <PageHead title="Churn Risk" lead="MRR at risk by customer health band." />
      </div>

      {/* Rendered whenever it has data, independently of whether any customer is
          scored yet: the rate series comes from mrr_snapshots, a different table,
          so gating it on the scored-customer count would withhold real history
          for an unrelated reason. Recova's window and sentence: 90 days of the
          daily snapshots, every 7th kept (getChurnView). */}
      {hasRateData ? (
        <div className="fh-intel-head">
          <Panel
            title="Churn rate over time"
            description="Involuntary churn (payment failures) vs voluntary churn (cancellations), last 90 days"
          >
            <ChurnRateChart points={view.ratePoints} />
          </Panel>
        </div>
      ) : null}

      {view.scoredCustomerCount === 0 ? (
        // Recova's empty card is a heading and a line. Capsomer's Empty puts
        // its title in a <p>, which would demote Recova's h2, so the nearest
        // Capsomer part that keeps the heading is a Panel (gap named in the
        // J29 notes).
        <Panel title="Health scores are being calculated.">
          <p className="fh-small fh-quiet">Check back after the next Intelligence sync.</p>
        </Panel>
      ) : (
        <>
          <div className="fh-churn-bands">
            {BAND_ORDER.map((band) => {
              const row = byBand.get(band) ?? { band, customerCount: 0, mrrCents: 0 };
              return (
                <Panel key={band} title={BAND_LABEL[band]} src={BAND_RANGE_LABEL[band]} size="sm">
                  <p className="fh-mono fh-display fh-medium cap-num fh-text">
                    {formatMoney(row.mrrCents, currency)}
                  </p>
                  <p className="fh-small fh-quiet">
                    {plural(row.customerCount, "customer")} ·{" "}
                    {percent(row.mrrCents, view.scoredMrrCents)}% of scored MRR
                  </p>
                </Panel>
              );
            })}
          </div>

          {view.topHighRisk.length > 0 ? (
            <Panel
              title="High-risk customers by MRR"
              description={`Top ${view.topHighRisk.length} customers in the high-risk band, sorted by monthly contribution.`}
              flush
            >
              <Table caption="High-risk customers by MRR" captionHidden reflow>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Plan</th>
                    <th scope="col" data-num="">
                      Health
                    </th>
                    <th scope="col" data-num="">
                      MRR
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.topHighRisk.map((row) => (
                    <tr key={row.stripeCustomerId}>
                      <th scope="row">
                        <Link
                          className="cap-table-open"
                          to={`/intelligence/customers/${row.stripeCustomerId}`}
                        >
                          {row.customerName ?? "(unnamed)"}
                        </Link>
                        {/* Recova's second line under the name: the Stripe id,
                              micro and mono. */}
                        <span className="fh-line fh-mono fh-tiny fh-faint">
                          {row.stripeCustomerId}
                        </span>
                      </th>
                      <td data-label="Plan">
                        {/* Recova's rounded border pill. Recova labels it from
                              current_plan_tier, which nothing in Foxhound writes
                              (signals.ts), so the plan's own name is shown. */}
                        <Pill variant="outline">{row.currentPlanName ?? "-"}</Pill>
                      </td>
                      <td data-label="Health" data-num="">
                        {/* Toned from the score rather than hardcoded red: the
                              query pre-filters to the high-risk band today, but a
                              widened predicate should not leave the color lying. */}
                        <span
                          className={`fh-mono fh-semibold ${healthScoreClassName(row.healthScore)}`}
                        >
                          {row.healthScore}
                        </span>
                      </td>
                      <td data-label="MRR" data-num="" className="fh-mono">
                        {row.mrrContributionCents > 0
                          ? formatMoney(row.mrrContributionCents, currency)
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

export function ChurnRateChart({ points }: { points: readonly ChurnRatePointLike[] }) {
  return <ChartFrame gridlines="none" draw={(width, fit) => drawChurnRate(points, width, fit)} />;
}
