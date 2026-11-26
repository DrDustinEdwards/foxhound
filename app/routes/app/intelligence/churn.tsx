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
import { accountScope } from "~/lib/auth/context";
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
import { noindexMeta } from "~/lib/seo/meta";

// /intelligence/churn: the head, the churn-rate chart (Enarratio), the three band cards, then the high-risk customers table; or, when nobody is scored yet, a "being calculated" card in place of the bands and table. Band cutoffs are Foxhound's engine (40/70), derived from the constants below.

export const meta = noindexMeta("Churn Risk - Foxhound");

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
  const { db, accountId } = accountScope(context);

  const view = await getChurnView(db, accountId, Date.now());
  return { view };
}

export default function IntelligenceChurn({ loaderData }: Route.ComponentProps) {
  const { view } = loaderData;
  const currency = "usd";

  const byBand = new Map(view.bands.map((b) => [b.band, b]));
  // The chart returns null unless some rate is above zero.
  const hasRateData = view.ratePoints.some(
    (p) => (p.voluntaryPct ?? 0) > 0 || (p.involuntaryPct ?? 0) > 0,
  );

  // max-w-[1280px] mx-auto px-4 md:px-8 py-8. The shell owns the page's one <main>, so this is a plain wrapper.
  return (
    <div className="fh-intel-page cap-admin-page" data-width="page">
      <div className="fh-intel-head">
        <PageHead title="Churn Risk" />
      </div>

      {hasRateData ? (
        <div className="fh-intel-head">
          <Panel
            title="Churn rate over time"
            meta="Last 90 days · involuntary is payment failures, voluntary is cancellations"
          >
            <ChurnRateChart points={view.ratePoints} />
          </Panel>
        </div>
      ) : null}

      {view.scoredCustomerCount === 0 ? (
        // Capsomer's Empty puts its title in a <p>, which would demote the h2, so this is its markup with the h2.
        <div className="cap-empty" data-kind="nothing-yet">
          <div className="cap-empty-header">
            <h2 className="cap-empty-title">Health scores are being calculated.</h2>
          </div>
        </div>
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
            <Panel title="High-risk customers by MRR" flush>
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
                        <span className="fh-line fh-mono fh-tiny fh-quiet">
                          {row.stripeCustomerId}
                        </span>
                      </th>
                      <td data-label="Plan">
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
