import { Pill, Status } from "capsomer/react/status";

import { deadlineClassName } from "~/lib/disputes/labels";
import { DISPUTE_FEE_OWED_WORDS } from "~/lib/marketing/disputes-copy";
import type { DisputesPreview, PreviewDisputeRow } from "~/lib/marketing/disputes-preview";

// The previews on /products/disputes (J57), Recova's three feature-block UIs:
// the disputes dashboard (DisputesDashboardPreview.tsx, blob dcde195e, which
// renders the real DisputesDashboardView, blob 3c1b7a98: five stat cards and
// the disputes table), the stat cards on their own (page.tsx's
// DisputesStatCardsPreview, blob c412d54f) and the dispute table
// (components/docs/DisputesTablePreview.tsx, blob ed33fa95).
//
// Content and layout are Recova's; the parts are Capsomer's (Q12). Every
// figure and row is the demo seed read through Foxhound's own dispute code
// (app/lib/marketing/disputes-preview.server.ts), never a merchant's rows.
// Recova draws no chart in any of the three, so neither does this page.
//
// Left out, each a QUESTION FOR THE SEAT in the J57 notes: the dashboard's
// per-row View link (Recova's points at /audit/<id>, a page Recova does not
// have), and the dispute table's Triage column (triage_recommendation has no
// producer outside the demo seed, the finding doc-widgets.tsx records for the
// docs). The fifth card, Saved vs Smart Disputes, stays and says it is not
// built (RULES.md 2.1: where Foxhound computes nothing, say so).

/** A dispute's state as Capsomer's badge: the engine's word, its tone's glyph
 *  and colour. A state mid-review is neither a success nor a failure
 *  (disputeStateTone), so it is a plain label with no tone. */
function StatePill({ row }: { row: PreviewDisputeRow }) {
  if (row.stateTone === "success") return <Pill tone="ok">{row.stateLabel}</Pill>;
  if (row.stateTone === "failure") return <Pill tone="crit">{row.stateLabel}</Pill>;
  return <Pill variant="secondary">{row.stateLabel}</Pill>;
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  // Recova's stat card leads nowhere, so it is a panel with a figure in it,
  // not Capsomer's stat tile, which is always a link or a button.
  return (
    <li className="cap-panel">
      <div className="cap-panel-body">
        <div>
          <p className="m-0 mb-1 text-micro font-medium uppercase tracking-[0.06em] text-text-tertiary">{label}</p>
          {children}
        </div>
      </div>
    </li>
  );
}

function Figure({ value }: { value: string | number }) {
  return <p className="m-0 font-mono text-title font-bold tabular-nums text-text">{value}</p>;
}

/** Recova's five cards. `columns` is Recova's grid: five across on the
 *  dashboard, three across in the numbers block. */
export function DisputeStatCards({ preview, columns }: { preview: DisputesPreview; columns: 3 | 5 }) {
  const { stats } = preview;
  const grid = columns === 5 ? "md:grid-cols-5" : "sm:grid-cols-3";
  return (
    <ul className={`m-0 grid list-none grid-cols-2 gap-3 p-0 ${grid}`} aria-label="Dispute figures">
      <StatCard label="Open disputes">
        <Figure value={stats.openCount} />
      </StatCard>
      <StatCard label="At stake">
        <Figure value={stats.atStake} />
      </StatCard>
      <StatCard label="Submitted by Foxhound">
        <Figure value={stats.submittedByFoxhound} />
      </StatCard>
      <StatCard label="Fees owed">
        <Figure value={stats.feesOwed} />
      </StatCard>
      <StatCard label="Saved vs Smart Disputes">
        <p className="m-0 text-label">
          <Status tone="nodata">Not built</Status>
        </p>
      </StatCard>
    </ul>
  );
}

/** Block 2: the stat cards on their own, as Recova's numbers block draws them. */
export function NumbersPreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="p-5">
      <DisputeStatCards preview={preview} columns={3} />
    </div>
  );
}

function DeadlineDays({ row }: { row: PreviewDisputeRow }) {
  // Recova leaves the cell empty once a dispute has closed.
  if (row.resolved || row.deadlineDays === null) return null;
  return <span className={`font-mono text-label ${deadlineClassName(row.deadlineUrgency)}`}>{row.deadlineDays}d</span>;
}

const DASHBOARD_CAPTION = "preview-disputes-dashboard";

/** Block 1: Recova's disputes dashboard, the five cards over the table. */
export function DashboardPreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="p-5">
      <div className="mb-8">
        <DisputeStatCards preview={preview} columns={5} />
      </div>
      <div className="cap-panel">
        <div className="cap-panel-body" data-flush>
          <div className="cap-table-wrap" role="region" aria-labelledby={DASHBOARD_CAPTION} tabIndex={0}>
            <table className="cap-table">
              <caption id={DASHBOARD_CAPTION} className="sr-only">
                Disputes
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="text-right">
                    Amount
                  </th>
                  <th scope="col">Reason</th>
                  <th scope="col">Foxhound status</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Fee</th>
                  <th scope="col">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {preview.dashboard.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <div className="text-label font-normal text-text">{row.customer}</div>
                      {row.email ? <div className="text-micro font-normal text-text-subtle">{row.email}</div> : null}
                    </th>
                    <td className="whitespace-nowrap text-right">
                      <span className="font-mono text-label text-text">{row.amount}</span>
                    </td>
                    <td>
                      <span className="text-label text-text-secondary">{row.reason}</span>
                    </td>
                    <td>
                      <StatePill row={row} />
                    </td>
                    <td>
                      {row.foxhoundSubmitted ? (
                        <span className="text-micro font-medium text-accent-text">Active</span>
                      ) : null}
                    </td>
                    <td>
                      {row.fee === "owed" ? (
                        <span className="whitespace-nowrap text-micro font-medium text-accent-text">
                          {DISPUTE_FEE_OWED_WORDS}
                        </span>
                      ) : row.fee === "none" ? (
                        <span className="whitespace-nowrap text-micro text-text-subtle">No charge</span>
                      ) : null}
                    </td>
                    <td>
                      <DeadlineDays row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const TABLE_CAPTION = "preview-disputes-table";

/** Block 3: Recova's dispute table, with the deadline as a date. */
export function DisputeTablePreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="p-5">
      <div className="cap-table-wrap" role="region" aria-labelledby={TABLE_CAPTION} tabIndex={0}>
        <table className="cap-table">
          <caption id={TABLE_CAPTION} className="sr-only">
            Disputes and their evidence deadlines
          </caption>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Amount</th>
              <th scope="col">Reason</th>
              <th scope="col">Status</th>
              <th scope="col">Deadline</th>
            </tr>
          </thead>
          <tbody>
            {preview.table.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <span className="text-label font-normal text-text">{row.customer}</span>
                </th>
                <td className="whitespace-nowrap">
                  <span className="font-mono text-label text-text">{row.amount}</span>
                </td>
                <td>
                  <span className="text-label text-text-secondary">{row.reason}</span>
                </td>
                <td>
                  <StatePill row={row} />
                </td>
                <td className="whitespace-nowrap">
                  {/* A closed dispute's deadline is history: no band colour. */}
                  <span
                    className={`font-mono text-label ${
                      row.resolved ? "text-text-tertiary" : deadlineClassName(row.deadlineUrgency)
                    }`}
                  >
                    {row.deadlineDate || "-"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
