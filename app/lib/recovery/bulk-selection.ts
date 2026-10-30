import { FAILED_PAYMENT_STATUS_ACTIVE } from "~/lib/constants";

// The S6 bulk-selection model, kept pure so the whole thing is provable without
// a DOM (vitest runs environment: "node", ruling 209's residue).
//
// THE ONE IDEA: the effective selection is ALWAYS the stored set intersected
// with what is currently on screen. Ruling 274 decision three requires the
// selection to prune to the visible set on every filter change; deriving it on
// read rather than mutating state on change makes that true BY CONSTRUCTION, so
// the count, the gate and the request set are one set and cannot disagree.
//
// That matters because legacy's defect is exactly the disagreement. Legacy holds
// a client Set that survives its client-side filtering, so ids the merchant can
// no longer see stay selected and are still submitted, while the bar's label
// counts only the visible active ones. parity/S6-BULK-SCOPE.md section 1.4 names
// it GATE-VERSUS-SUBMIT, and 274 decisions two and three repair both halves.
//
// A NOTE ON WHY DERIVATION RATHER THAN AN EFFECT. Foxhound's filters are URL
// navigations, not client state, so a filter change re-runs the loader. Whether
// React preserves this component's useState across a same-route navigation is a
// framework detail this repo has no instrument to observe (no DOM in the test
// environment, and the demo cannot exercise it). Deriving the effective
// selection makes the answer IRRELEVANT: stale ids can sit in state forever and
// still never reach a count, a gate, or a request.

export interface SelectableRow {
  id: string;
  status: string;
}

/**
 * The effective selection: stored ids that are still on screen, in the rows'
 * own order so downstream output is deterministic rather than insertion-ordered.
 */
export function visibleSelection(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): string[] {
  return rows.filter((r) => selected.has(r.id)).map((r) => r.id);
}

/** How many selected, visible rows there are. The number the bar shows. */
export function selectedCount(selected: ReadonlySet<string>, rows: readonly SelectableRow[]): number {
  return visibleSelection(selected, rows).length;
}

/**
 * The ACTIONABLE subset: selected, visible, and active.
 *
 * Legacy computes the same intersection for its label (`activeSelected` in
 * PaymentsClient.tsx) and then submits something else. Under 274 decision two
 * this is the ONLY set a bulk action may act on, so the label is true by
 * definition rather than by coincidence.
 */
export function actionableSelection(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): string[] {
  return rows
    .filter((r) => selected.has(r.id) && r.status === FAILED_PAYMENT_STATUS_ACTIVE)
    .map((r) => r.id);
}

/** Legacy's `allSelected`: every visible row is selected, and there is at least
 *  one. An empty page is NOT "all selected", or the header checkbox would read
 *  checked on a page with nothing to check. */
export function allVisibleSelected(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): boolean {
  return rows.length > 0 && rows.every((r) => selected.has(r.id));
}

/**
 * Legacy's `toggleAll`, ported including its replace-not-merge behavior: when
 * not everything visible is selected, the set becomes EXACTLY the visible page
 * (select-all selects the visible page), and when everything
 * visible is already selected, it clears.
 *
 * Replacing rather than merging is legacy's own choice and it is kept, because
 * merging would accumulate off-page ids that the effective selection would then
 * silently drop, which is the invisible-state problem wearing a different hat.
 */
export function toggleAllVisible(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): Set<string> {
  if (allVisibleSelected(selected, rows)) return new Set();
  return new Set(rows.map((r) => r.id));
}

/** Legacy's `toggleRow`: add or remove one id, leaving the rest alone. */
export function toggleOne(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
