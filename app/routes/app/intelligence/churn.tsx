import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { lineChart } from "enarratio/lite/line";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import "enarratio/base.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";

import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { healthScoreClassName, WATCH_CEILING, type HealthScoreBand } from "~/lib/intelligence/health-band";
import { churnBandSharePct, churnRateAlt, type ChurnRatePointLike } from "~/lib/intelligence/churn";
import { getChurnView, isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/churn";

// /intelligence/churn (row S19, job J29). Recova is the spec: its real page,
// app/(app)/intelligence/churn/page.tsx at blob 718cd7f5, and its chart,
// app/(app)/intelligence/churn/components/ChurnRateChart.tsx at blob f4b9d3e5,
// both read whole. In Recova's order and width: the head, the churn-rate chart,
// the three band cards, then the high-risk customers table; or, when nobody is
// scored yet, Recova's "being calculated" card in place of the bands and table.
//
// Built from Capsomer 0.9.0's parts (Q10) with the chart drawn by Enarratio
// (Q1), teal throughout (Q11). No Foxhound CSS sits over a Capsomer component:
// Recova's band tints, its pill colours per plan and its 12px radius wait for
// Capsomer's per-site layer (capsomer job_ec5ec0754626), listed in the J29
// notes. Band cutoffs are Foxhound's engine (40/70, rulings 78/79), derived
// from the constants below, never Recova's 33/66.

export function meta() {
  return [{ title: "Churn Risk - Foxhound" }];
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
  // Recova's ChurnRateChart returns null unless some rate is above zero.
  const hasRateData = view.ratePoints.some(
    (p) => (p.voluntaryPct ?? 0) > 0 || (p.involuntaryPct ?? 0) > 0,
  );

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8. The shell owns
  // the page's one <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
      <div className="mb-6">
        <PageHead title="Churn Risk" lead="MRR at risk by customer health band." />
      </div>

      {/* Rendered whenever it has data, independently of whether any customer is
          scored yet: the rate series comes from mrr_snapshots, a different table,
          so gating it on the scored-customer count would withhold real history
          for an unrelated reason. Recova's own sentence carries Foxhound's real
          window: the snapshot cron is monthly here, so the series is twelve
          months, and "last 90 days" would be a false claim about our own data. */}
      {hasRateData ? (
        <div className="mb-6">
          <Panel
            title="Churn rate over time"
            description="Involuntary churn (payment failures) vs voluntary churn (cancellations), last 12 months"
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
          <p className="m-0 text-label text-text-tertiary">Check back after the next Intelligence sync.</p>
        </Panel>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            {BAND_ORDER.map((band) => {
              const row = byBand.get(band) ?? { band, customerCount: 0, mrrCents: 0 };
              return (
                <Panel key={band} title={BAND_LABEL[band]} src={BAND_RANGE_LABEL[band]} size="sm">
                  <p className="m-0 font-mono text-display font-medium tabular-nums text-text">
                    {formatMoney(row.mrrCents, currency)}
                  </p>
                  <p className="m-0 text-label text-text-tertiary">
                    {row.customerCount} {row.customerCount === 1 ? "customer" : "customers"} ·{" "}
                    {churnBandSharePct(row.mrrCents, view.scoredMrrCents)}% of scored MRR
                  </p>
                </Panel>
              );
            })}
          </div>

          {view.topHighRisk.length > 0 ? (
            <Panel
              title="High-risk customers by MRR"
              headingId="churn-high-risk"
              description={`Top ${view.topHighRisk.length} customers in the high-risk band, sorted by monthly contribution.`}
              flush
            >
              <div
                className="cap-table-wrap"
                data-cap="table"
                role="region"
                aria-labelledby="churn-high-risk"
                tabIndex={0}
              >
                <table className="cap-table">
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
                          <Link className="cap-table-open" to={`/intelligence/customers/${row.stripeCustomerId}`}>
                            {row.customerName ?? "(unnamed)"}
                          </Link>
                          {/* Recova's second line under the name: the Stripe id,
                              micro and mono. */}
                          <span className="block font-mono text-micro text-text-subtle">{row.stripeCustomerId}</span>
                        </th>
                        <td>
                          {/* Recova's rounded border pill. Recova labels it from
                              current_plan_tier, which nothing in Foxhound writes
                              (signals.ts), so the plan's own name is shown. */}
                          <Pill variant="outline">{row.currentPlanName ?? "-"}</Pill>
                        </td>
                        <td data-num="">
                          {/* Toned from the score rather than hardcoded red: the
                              query pre-filters to the high-risk band today, but a
                              widened predicate should not leave the colour lying. */}
                          <span className={`font-mono font-semibold ${healthScoreClassName(row.healthScore)}`}>
                            {row.healthScore}
                          </span>
                        </td>
                        <td data-num="" className="font-mono">
                          {row.mrrContributionCents > 0 ? formatMoney(row.mrrContributionCents, currency) : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

// The drawing's width before the panel is measured, and on the server: about
// the panel body's width in Recova's 1280px column. In the browser the chart
// is redrawn at its panel's measured width, so its text keeps its set size at
// every width instead of shrinking with a phone screen (Recova's chart is a
// ResponsiveContainer at 100% width).
const CHART_WIDTH = 1180;
const CHART_MIN_WIDTH = 280;
// Recova's ResponsiveContainer is 180px tall with its axes inside; Enarratio
// draws its legend outside the SVG and keeps 64px of the height for its axes.
const CHART_HEIGHT = 220;

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

interface ChurnRow {
  // Capitalised because Enarratio names the data table's first column after it.
  Month: string;
  series: "Involuntary" | "Voluntary";
  rate: number | null;
}

function drawChurnRate(points: readonly ChurnRatePointLike[], width: number): string {
  const data: ChurnRow[] = points.flatMap((p) => {
    const Month = p.at.toISOString().slice(0, 10);
    return [
      { Month, series: "Involuntary" as const, rate: p.involuntaryPct },
      { Month, series: "Voluntary" as const, rate: p.voluntaryPct },
    ];
  });
  return lineChart({
    data,
    x: "Month",
    y: "rate",
    series: "series",
    // Recova's legend order: Involuntary, then Voluntary.
    seriesDomain: ["Involuntary", "Voluntary"],
    xLabel: null,
    // Enarratio 0.3.1 has no tick format, so Recova's "2%" ticks read as "2"
    // under this axis label until it does (enarratio gap, J29 notes).
    yLabel: "Churn rate (%)",
    formatValue: (v) => `${Math.round(v * 100) / 100}%`,
    formatX: (v) => MONTH_LABEL.format(v),
    alt: churnRateAlt(points),
    width,
    height: CHART_HEIGHT,
  });
}

function ChurnRateChart({ points }: { points: readonly ChurnRatePointLike[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(CHART_WIDTH);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(Math.max(CHART_MIN_WIDTH, measured));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const drawn = useMemo(() => {
    // Enarratio refuses input it cannot draw honestly by throwing; one chart's
    // refusal must not take the page down, so it is shown in the chart's place.
    try {
      return { html: drawChurnRate(points, width) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [points, width]);

  if ("error" in drawn) {
    return <p className="m-0 text-label text-text-tertiary">This chart could not be drawn: {drawn.error}</p>;
  }
  // min-w-0: Capsomer's panel body is a grid, whose items default to their
  // content's width, so without it the measured width could never drop below
  // the drawing's and a phone would get a sideways-scrolling chart.
  return <div ref={ref} className="min-w-0" dangerouslySetInnerHTML={{ __html: drawn.html }} />;
}
