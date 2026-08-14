/**
 * S6's stat-card value treatments, ported from legacy's PaymentsStats.tsx
 * (app/(app)/recovery/payments/components/PaymentsStats.tsx, blob b386c66,
 * 1,249 bytes, read whole).
 *
 * CLIENT-SAFE BY CONSTRUCTION. These run inside the route COMPONENT, so they
 * must not live in a `.server` module: 276's bundle-boundary class is exactly
 * this mistake, where a client-half export placed behind the server boundary
 * typechecks, lints and passes every test under vitest's node importer, then
 * ships a page that breaks only in a browser.
 *
 * The counts argument is declared structurally rather than imported from
 * queries.server.ts, so this module has no import edge into server code at all.
 */

export interface StatusCountsShape {
  all: number;
  active: number;
  recovered: number;
  cancelled: number;
  failedUnrecovered: number;
}

/**
 * Legacy's "Showing" card value:
 *
 *   showing={status === 'all' ? globalCounts.all
 *                             : (globalCounts[status] ?? globalCounts.all)}
 *
 * read at the call site in PaymentsClient.tsx, which is the read that corrected
 * 188 (see 279). The card is a GLOBAL count that responds ONLY to the selected
 * status pill: it ignores search, category, date and amount entirely, exactly
 * as legacy's other four cards do. 188 recorded it as a filtered count against
 * a global one, and both halves of that were wrong.
 *
 * Legacy keys `globalCounts` by the raw status string, so its lookup is a plain
 * index with an `?? all` fallback. Foxhound's counts are camelCase, so the
 * mapping is explicit and the fallback is PORTED rather than dropped: an
 * unrecognised `status` in the URL reads the same total legacy would show.
 *
 * Foxhound's "no status filter" sentinel is the empty string where legacy's is
 * the literal 'all'; both mean the same pill and both land on `counts.all`.
 */
export function showingCountFor(counts: StatusCountsShape, status: string): number {
  if (status === "" || status === "all") return counts.all;
  if (status === "active") return counts.active;
  if (status === "recovered") return counts.recovered;
  if (status === "cancelled") return counts.cancelled;
  if (status === "failed_unrecovered") return counts.failedUnrecovered;
  return counts.all;
}

/**
 * Legacy's thresholded colour for the "Recovery rate" card value:
 *
 *   colorClass: recoveryRate >= 36 ? 'text-green'
 *             : recoveryRate >= 21 ? 'text-amber-text'
 *             : 'text-red'
 *
 * The two cutoffs are legacy's own numbers, read from source rather than
 * inferred, and both boundaries are inclusive. Every class name here exists in
 * Foxhound's token set under the same name, so nothing is minted and nothing is
 * approximated.
 */
export function recoveryRateValueClass(ratePct: number): string {
  if (ratePct >= 36) return "text-green";
  if (ratePct >= 21) return "text-amber-text";
  return "text-red";
}
