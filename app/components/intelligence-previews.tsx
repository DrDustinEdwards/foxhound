import { frameHtml } from "capsomer/behavior/chart-frame";
import { Pill } from "capsomer/react/status";

import "~/components/charts.css";
import { StaticStatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/stat-tile.css";
import { drawPlans } from "~/lib/intelligence/dashboard-charts";
import { METER_TONE, type HealthScoreBand } from "~/lib/intelligence/health-band";
import type { IntelligencePreview } from "~/lib/marketing/intelligence-preview";
import { markup } from "capsomer/behavior/trusted-html";

// The previews on /product/intelligence, Recova's three feature-block
// UIs: the Intelligence dashboard (IntelligenceDashboardPreview.tsx, blob
// 11972333, which mounts the dashboard's MRRStatCards, 2920fa3b, and
// PlanBreakdown, 65b5674f, over a narrative card), the customer table
// (components/docs/IntelligenceCustomerTable.tsx, 6ae7c73f, with
// HealthScoreBadge, f25f29d8) and the churn bands
// (components/docs/ChurnRiskSummary.tsx, ba1fbb51).
//
// Content and layout are Recova's; the parts are Capsomer's and the one
// chart is Enarratio's, drawn by the dashboard's own drawPlans. The page
// does not hydrate, so the chart is drawn on the server twice, at the frame's
// width and narrow, in Capsomer's server frame: the charts island
// (app/islands/charts.ts, Capsomer's chart-enhance) swaps in the narrow
// drawing in a column under 30rem, so a phone keeps 12 px text, and adds
// Enarratio's enhancement layer as on every other chart. Every
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

/** ChurnRiskSummary's words for the three bands. */
const BAND_LABEL: Record<HealthScoreBand, string> = {
  at_risk: "High risk",
  watch: "Medium",
  healthy: "Healthy",
};

/** A label over a figure, as Recova's cards have: micro, uppercase, tertiary. */
function CardLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 fh-tiny fh-medium uppercase tracking-[0.06em] fh-quiet">{children}</p>;
}

/** The width a 320 px phone leaves the chart inside the preview's two panels. */
const NARROW_WIDTH = 196;

/** The plans chart in Capsomer's server frame, with its narrow drawing as Enarratio's redraw spec. */
function planFrame(draw: (width: number) => string): string {
  const narrow = draw(NARROW_WIDTH);
  const start = narrow.indexOf('<div class="enarratio-frame');
  const end = narrow.indexOf("</svg></div>", start) + "</svg></div>".length;
  return frameHtml(draw(480), {
    gridlines: "x",
    ...(start >= 0 && end > start ? { redraw: { narrow: narrow.slice(start, end) } } : {}),
  });
}

/** Block 1: Recova's dashboard preview, four cards, MRR by plan, the narrative. */
export function DashboardPreview({ preview }: { preview: IntelligencePreview }) {
  const { dashboard } = preview;
  const draw = (width: number) =>
    drawPlans(
      dashboard.plans,
      dashboard.currency,
      width,
      {},
      { name: "Foxhound demo account (sample data)" },
    );
  const chart = dashboard.plans.length > 0 ? planFrame(draw) : "";
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="fh-tiles-preview [--tiles-columns:repeat(2,minmax(0,1fr))] md:[--tiles-columns:repeat(4,minmax(0,1fr))]">
        <StatTiles layout="grid" label="MRR figures">
          <StaticStatTile label="MRR" tone="accent" figure={dashboard.mrr} />
          <StaticStatTile
            label="Day-over-day"
            tone={
              dashboard.dayOverDaySign > 0
                ? "ok"
                : dashboard.dayOverDaySign < 0
                  ? "crit"
                  : undefined
            }
            figure={dashboard.dayOverDay}
          />
          <StaticStatTile label="Active customers" figure={dashboard.activeCustomers} />
          <StaticStatTile label="New MRR (MTD)" tone="ok" figure={dashboard.newMrrMtd} />
        </StatTiles>
      </div>
      {dashboard.plans.length > 0 ? (
        <div className="cap-panel">
          <div className="cap-panel-body">
            <div data-island="charts" dangerouslySetInnerHTML={markup(chart)} />
          </div>
        </div>
      ) : null}
      <div className="cap-panel">
        <div className="cap-panel-body">
          <div>
            <CardLabel>{dashboard.narrativeMonth} narrative</CardLabel>
            <p className="fh-small fh-relaxed fh-soft">{dashboard.narrative}</p>
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
      <div
        className="cap-table-wrap"
        data-reflow=""
        role="region"
        aria-labelledby={TABLE_CAPTION}
        tabIndex={0}
      >
        <table className="cap-table">
          <caption id={TABLE_CAPTION} className="cap-sr-only">
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
                  <span className="fh-small fh-regular fh-text">{row.name}</span>
                </th>
                <td data-label="Plan">
                  {/* Capsomer's pill markup rather than its Pill component,
                      which adds a status glyph to any toned pill; a plan is
                      not a status. The same choice as the directory. */}
                  <span
                    className="cap-pill"
                    data-tone={row.planTone ?? undefined}
                    data-variant="outline"
                  >
                    {row.planLabel}
                  </span>
                </td>
                <td data-label="Health">
                  <Pill tone={METER_TONE[row.band]}>{row.healthScore}</Pill>
                </td>
                <td data-label="MRR" className="fh-nowrap">
                  <span className="fh-mono fh-small fh-text">{row.mrr}</span>
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
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="MRR by health band">
        {preview.bands.map((b) => (
          <li key={b.band} className="cap-panel">
            <div className="cap-panel-body">
              <div>
                <p className="mb-1">
                  <Pill tone={METER_TONE[b.band]}>{BAND_LABEL[b.band]}</Pill>
                </p>
                <p className="fh-mono fh-title fh-medium cap-num fh-text">{b.customerCount}</p>
                <p className="mt-0.5 fh-mono fh-small fh-soft">
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
