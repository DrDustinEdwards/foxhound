import { Table } from "capsomer/react/table";
import { Pill } from "capsomer/react/status";

import { StaticStatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/stat-tile.css";
import { deadlineClassName } from "~/lib/disputes/labels";
import type { DisputesPreview, PreviewDisputeRow } from "~/lib/marketing/disputes-preview";
import "capsomer/table.css";

// The previews on /product/disputes, Recova's three feature-block UIs:
// the disputes dashboard (DisputesDashboardPreview.tsx, blob dcde195e, which
// renders the real DisputesDashboardView, blob 3c1b7a98: five stat cards and
// the disputes table), the stat cards on their own (page.tsx's
// DisputesStatCardsPreview, blob c412d54f) and the dispute table
// (components/docs/DisputesTablePreview.tsx, blob ed33fa95).
//
// Content and layout are Recova's; the parts are Capsomer's. Every
// figure and row is the demo seed read through Foxhound's own dispute code
// (app/lib/marketing/disputes-preview.server.ts), never a merchant's rows.
// Recova draws no chart in any of the three, so neither does this page.
//
// The dashboard preview has the merchant /disputes dashboard's columns, not
// Recova's Mode and Fee: Mode is out for good (Dustin, 2026-10-15,
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6), and a Fee cell saying
// "fee owed" would be untrue beside a Fees owed card that reads $0.00 (the
// demo's fees are paid), as well as a column the dashboard does not have.
//
// Left out, a QUESTION FOR THE SEAT in the J57 notes: the dashboard's per-row
// View link (Recova's points at /audit/<id>, a page Recova does not have).
// The dispute table's Triage column is Recova's TriagePill (blob 1485726d):
// fight in green, accept as a plain label, each with its confidence.
//
// The cards are the merchant /disputes dashboard's five, the set Dustin
// approved on PR #75 ("yes ro all", 2026-10-15,
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6): Open disputes, At
// stake, Submitted by Foxhound, Fees owed and Win rate. Recova's Saved vs
// Smart Disputes is not built, so neither page draws it.

/** A dispute's status as Capsomer's badge: the dashboard's word
 *  (disputeListStatus), its tone's glyph and color. A status mid-review is
 *  neither a success nor a failure, so it is a plain label with no tone. */
function StatePill({ row }: { row: PreviewDisputeRow }) {
  if (row.stateTone === "success") return <Pill tone="ok">{row.stateLabel}</Pill>;
  if (row.stateTone === "failure") return <Pill tone="crit">{row.stateLabel}</Pill>;
  return <Pill variant="secondary">{row.stateLabel}</Pill>;
}

/** Recova's TriagePill: "Fight 82%" in green, "Accept 68%" plain. */
function TriagePill({ row }: { row: PreviewDisputeRow }) {
  if (!row.triage) return <span className="fh-small fh-quiet">-</span>;
  const label = row.triage.recommendation === "fight" ? "Fight" : "Accept";
  const confidence =
    row.triage.confidence === null ? null : (
      <span className="fh-mono">{row.triage.confidence}%</span>
    );
  return row.triage.recommendation === "fight" ? (
    <Pill tone="ok">
      {label} {confidence}
    </Pill>
  ) : (
    <Pill variant="secondary">
      {label} {confidence}
    </Pill>
  );
}

/** The dashboard's five cards. `columns` is Recova's grid: five across on the
 *  dashboard, three across in the numbers block. */
function DisputeStatCards({ preview, columns }: { preview: DisputesPreview; columns: 3 | 5 }) {
  const { stats } = preview;
  const grid = columns === 5 ? "fh-dispprev-tiles-5" : "fh-dispprev-tiles-3";
  return (
    <div className={`fh-dispprev-block fh-tiles-preview ${grid}`}>
      <StatTiles layout="grid" label="Dispute figures">
        <StaticStatTile label="Open disputes" figure={stats.openCount} />
        <StaticStatTile label="At stake" figure={stats.atStake} />
        <StaticStatTile label="Submitted by Foxhound" figure={stats.submittedByFoxhound} />
        <StaticStatTile label="Fees owed" figure={stats.feesOwed} />
        <StaticStatTile label="Win rate" figure={stats.winRate} detail={stats.winRateSubtext} />
      </StatTiles>
    </div>
  );
}

/** Block 2: the stat cards on their own, as Recova's numbers block draws them. */
export function NumbersPreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="fh-dispprev-block-2">
      <DisputeStatCards preview={preview} columns={3} />
    </div>
  );
}

function DeadlineDays({ row }: { row: PreviewDisputeRow }) {
  // Recova leaves the cell empty once a dispute has closed.
  if (row.resolved || row.deadlineDays === null) return null;
  // A passed deadline reads 0d in the overdue color, never a negative count.
  return (
    <span className={`fh-mono fh-small ${deadlineClassName(row.deadlineUrgency)}`}>
      {Math.max(0, row.deadlineDays)}d
    </span>
  );
}

/** Block 1: Recova's disputes dashboard, the five cards over the table. */
export function DashboardPreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="fh-dispprev-block-2">
      <div className="fh-dispprev-block-3">
        <DisputeStatCards preview={preview} columns={5} />
      </div>
      <div className="cap-panel">
        <div className="cap-panel-body" data-flush>
          <Table caption="Disputes" captionHidden reflow>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="fh-right">
                  Amount
                </th>
                <th scope="col">Reason</th>
                <th scope="col">Foxhound status</th>
                <th scope="col">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {preview.dashboard.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <div className="fh-small fh-regular fh-text">{row.customer}</div>
                    {row.email ? (
                      <div className="fh-tiny fh-regular fh-faint">{row.email}</div>
                    ) : null}
                  </th>
                  <td data-label="Amount" className="fh-nowrap fh-right">
                    <span className="fh-mono fh-small fh-text">{row.amount}</span>
                  </td>
                  <td data-label="Reason">
                    <span className="fh-small fh-soft">{row.reason}</span>
                  </td>
                  <td data-label="Foxhound status">
                    <StatePill row={row} />
                  </td>
                  <td data-label="Deadline">
                    <DeadlineDays row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
    </div>
  );
}

/** Block 3: Recova's dispute table, with the deadline as a date. */
export function DisputeTablePreview({ preview }: { preview: DisputesPreview }) {
  return (
    <div className="fh-dispprev-block-2">
      <Table caption="Disputes and their evidence deadlines" captionHidden reflow>
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Amount</th>
            <th scope="col">Reason</th>
            <th scope="col">Triage</th>
            <th scope="col">Status</th>
            <th scope="col">Deadline</th>
          </tr>
        </thead>
        <tbody>
          {preview.table.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <span className="fh-small fh-regular fh-text">{row.customer}</span>
              </th>
              <td data-label="Amount" className="fh-nowrap">
                <span className="fh-mono fh-small fh-text">{row.amount}</span>
              </td>
              <td data-label="Reason">
                <span className="fh-small fh-soft">{row.reason}</span>
              </td>
              <td data-label="Triage">
                <TriagePill row={row} />
              </td>
              <td data-label="Status">
                <StatePill row={row} />
              </td>
              <td data-label="Deadline" className="fh-nowrap">
                {/* A closed dispute's deadline is history: no band color. */}
                <span
                  className={`fh-mono fh-small ${
                    row.resolved ? "fh-quiet" : deadlineClassName(row.deadlineUrgency)
                  }`}
                >
                  {row.deadlineDate || "-"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
