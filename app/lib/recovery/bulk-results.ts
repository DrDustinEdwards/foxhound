import type { ManualActionOutcome } from "./manual-actions.server";

// The CLIENT-SAFE half of S6 bulk actions (274 decisions one, four and five).
//
// This module is deliberately NOT `.server`, because the payments list renders
// the result surface in the browser and needs isBulkRefusal, orderForDisplay
// and failedIds there. A `.server` module is stripped from the client bundle,
// so putting these next to the fan-out would have typechecked and then failed
// in a browser. Everything here is pure: no db, no bindings, no fetch. The only
// import is a TYPE, which erases.
//
// The fan-out itself (mapWithConcurrency, runBulkAction) stays in
// bulk-actions.server.ts, where it belongs.

/** Why one payment in a bulk submission did not succeed. Each maps 1:1 onto a
 *  dispatcher outcome, so the surface can say WHICH refusal happened rather than
 *  folding them into a count (274 decision one). */
export type BulkFailureReason =
  | "not_found"
  | "not_active"
  | "already_resolved"
  | "write_failed"
  /** The dispatcher answered something this intent is not expected to produce.
   *  Kept as its own value rather than swallowed: an unexpected outcome is a
   *  finding, not a silent success. */
  | "unexpected";

export interface BulkItemResult {
  id: string;
  ok: boolean;
  reason: BulkFailureReason | null;
}

export interface BulkActionResult {
  intent: string;
  results: BulkItemResult[];
}

/** The submission was refused as a whole, before any payment was touched. */
export interface BulkActionRefusal {
  refused: "empty" | "over_ceiling";
  /** How many ids were submitted, so the surface can name the exact number
   *  rather than saying "too many" (274 decision four: never silently
   *  truncated, and the ceiling is stated). */
  submitted: number;
  ceiling: number;
}

export function isBulkRefusal(value: BulkActionResult | BulkActionRefusal): value is BulkActionRefusal {
  return "refused" in value;
}

/** Map one dispatcher outcome onto a per-item result. Cancel's reachable set is
 *  narrow, and that narrowness is itself measured: `processing_paused` is
 *  returned ONLY inside the trigger path (the brake gate Session C added), so a
 *  brake-engaged account does NOT refuse a Stop recovery. Stopping a sequence is
 *  the opposite of processing one, which is why the single-payment path does not
 *  gate it and why this layer does not add a gate the intent never had. */
export function toItemResult(id: string, outcome: ManualActionOutcome): BulkItemResult {
  if (outcome.ok) return { id, ok: true, reason: null };
  switch (outcome.reason) {
    case "not_found":
    case "not_active":
    case "already_resolved":
    case "write_failed":
      return { id, ok: false, reason: outcome.reason };
    default:
      return { id, ok: false, reason: "unexpected" };
  }
}

/** Failures first, then successes, each group in input order (274 decision one:
 *  the surface itemises with failures surfaced first). */
export function orderForDisplay(results: readonly BulkItemResult[]): BulkItemResult[] {
  return [...results.filter((r) => !r.ok), ...results.filter((r) => r.ok)];
}

/** The ids a merchant should still have selected after the response lands:
 *  exactly the ones that failed, so the next click retries precisely those and
 *  nothing else (274 decision one). Successes drop out of the selection. */
export function failedIds(results: readonly BulkItemResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.id);
}
