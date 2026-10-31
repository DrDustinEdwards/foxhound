import { useCallback } from "react";
import { ChartFrame } from "capsomer/react/chart-frame";
import { Pill, type Tone } from "capsomer/react/status";

import "~/components/charts.css";
import { PreviewStatCard } from "~/components/stat-card";
import { drawPlans } from "~/lib/intelligence/dashboard-charts";
import type { HealthScoreBand } from "~/lib/intelligence/health-band";
import type { IntelligencePreview } from "~/lib/marketing/intelligence-preview";

// The previews on /product/intelligence, Recova's three feature-block
// UIs: the Intelligence dashboard (IntelligenceDashboardPreview.tsx, blob
// 11972333, which mounts the dashboard's MRRStatCards, 2920fa3b, and
// PlanBreakdown, 65b5674f, over a narrative card), the customer table
// (components/docs/IntelligenceCustomerTable.tsx, 6ae7c73f, with
// HealthScoreBadge, f25f29d8) and the churn bands
// (components/docs/ChurnRiskSummary.tsx, ba1fbb51).
//
// Content and layout are Recova's; the parts are Capsomer's and the one
// chart is Enarratio's, drawn by the dashboard's own drawPlans. Every
// figure and row is the demo seed read through Foxhound's own Intelligence
// code (app/lib/marketing/intelligence-preview.server.ts), never a merchant's
// rows.
//
// Where Foxhound's dashboard differs from Recova's, the preview follows the
// dashboard (app/routes/app/intelligence/index.tsx): MRR by plan shows no
// customer count, because the snapshot keeps none.
//
// Left out: the customer table's Action column. Recova's reads a recommended
// action, and nothing in Foxhound writes one (digest-email.ts records the same
// finding). The J58 notes list it for the seat.

/** A health band as Capsomer's badge tone: the color Recova's
 *  HealthScoreBadge and ChurnRiskSummary give it (red, the warning color,
 *  green), at Foxhound's cutoffs (healthScoreBand). */
const BAND_TONE: Record<HealthScoreBand, Tone> = { at_risk: "crit", watch: "warn", healthy: "ok" };

/** ChurnRiskSummary's words for the three bands. */
const BAND_LABEL: Record<HealthScoreBand, string> = { at_risk: "High risk", watch: "Medium", healthy: "Healthy" };

/** A label over a figure, as Recova's cards have: micro, uppercase, tertiary. */
function CardLabel({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mb-1 text-micro font-medium uppercase tracking-[0.06em] text-text-tertiary">{children}</p>;
}

/** Block 1: Recova's dashboard preview, four cards, MRR by plan, the narrative. */
export function DashboardPreview({ preview }: { preview: IntelligencePreview }) {
  const { dashboard } = preview;
  const draw = useCallback(
    (width: number) => drawPlans(dashboard.plans, dashboard.currency, width, { name: "Foxhound demo account (sample data)" }),
    [dashboard.plans, dashboard.currency],
  );
  return (
    <div className="flex flex-col gap-5 p-5">
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-4" aria-label="MRR figures">
        <PreviewStatCard label="MRR">
          <p className="m-0 font-mono text-title font-bold tabular-nums text-accent-text">{dashboard.mrr}</p>
        </PreviewStatCard>
        <PreviewStatCard label="Day-over-day">
          <p
            className={`m-0 font-mono text-title font-bold tabular-nums ${
              dashboard.dayOverDaySign > 0
                ? "text-success-text"
                : dashboard.dayOverDaySign < 0
                  ? "text-error-text"
                  : "text-text-tertiary"
            }`}
          >
            {dashboard.dayOverDay}
          </p>
        </PreviewStatCard>
        <PreviewStatCard label="Active customers">
          <p className="m-0 font-mono text-title font-bold tabular-nums text-text">{dashboard.activeCustomers}</p>
        </PreviewStatCard>
        <PreviewStatCard label="New MRR (MTD)">
          <p className="m-0 font-mono text-title font-bold tabular-nums text-success-text">{dashboard.newMrrMtd}</p>
        </PreviewStatCard>
      </ul>
      {dashboard.plans.length > 0 ? (
        <div className="cap-panel">
          <div className="cap-panel-body">
            <ChartFrame gridlines="x" draw={draw} />
          </div>
        </div>
      ) : null}
      <div className="cap-panel">
        <div className="cap-panel-body">
          <div>
            <CardLabel>{dashboard.narrativeMonth} narrative</CardLabel>
            <p className="m-0 text-label leading-relaxed text-text-secondary">{dashboard.narrative}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABLE_CAPTION = "preview-intelligence-customers";

/** Block 2: Recova's customer table, worst health first. */
export function CustomerTablePreview({ preview }: { preview: IntelligencePreview }) {
  return (
    <div className="p-5">
      <div className="cap-table-wrap" data-reflow="" role="region" aria-labelledby={TABLE_CAPTION} tabIndex={0}>
        <table className="cap-table">
          <caption id={TABLE_CAPTION} className="sr-only">
            Customers by health score, lowest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Plan</th>
              <th scope="col">Health</th>
              <th scope="col">MRR</th>
            </tr>
          </thead>
          <tbody>
            {preview.customers.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <span className="text-label font-normal text-text">{row.name}</span>
                </th>
                <td data-label="Plan">
                  {/* Capsomer's pill markup rather than its Pill component,
                      which adds a status glyph to any toned pill; a plan is
                      not a status. The same choice as the directory. */}
                  <span className="cap-pill" data-tone={row.planTone ?? undefined} data-variant="outline">
                    {row.planLabel}
                  </span>
                </td>
                <td data-label="Health">
                  <Pill tone={BAND_TONE[row.band]}>{row.healthScore}</Pill>
                </td>
                <td data-label="MRR" className="whitespace-nowrap">
                  <span className="font-mono text-label text-text">{row.mrr}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Block 3: Recova's churn summary, the three bands, high risk first. */
export function ChurnBandsPreview({ preview }: { preview: IntelligencePreview }) {
  return (
    <div className="p-5">
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3" aria-label="MRR by health band">
        {preview.bands.map((b) => (
          <li key={b.band} className="cap-panel">
            <div className="cap-panel-body">
              <div>
                <p className="m-0 mb-1">
                  <Pill tone={BAND_TONE[b.band]}>{BAND_LABEL[b.band]}</Pill>
                </p>
                <p className="m-0 font-mono text-title font-medium tabular-nums text-text">{b.customerCount}</p>
                <p className="m-0 mt-0.5 font-mono text-label text-text-secondary">
                  {b.mrr}/mo{b.band === "at_risk" ? " at risk" : ""}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
