/**
 * CLIENT-SAFE BY CONSTRUCTION. These run inside the route COMPONENT, so they must not live in a
 * `.server` module: 276's bundle-boundary class is exactly this mistake, where a client-half export
 * placed behind the server boundary typechecks, lints and passes every test under vitest's node
 * importer, then ships a page that breaks only in a browser.
 */

export interface StatusCountsShape {
  all: number;
  active: number;
  recovered: number;
  cancelled: number;
  failedUnrecovered: number;
}

export function showingCountFor(counts: StatusCountsShape, status: string): number {
  if (status === "" || status === "all") return counts.all;
  if (status === "active") return counts.active;
  if (status === "recovered") return counts.recovered;
  if (status === "cancelled") return counts.cancelled;
  if (status === "failed_unrecovered") return counts.failedUnrecovered;
  return counts.all;
}
