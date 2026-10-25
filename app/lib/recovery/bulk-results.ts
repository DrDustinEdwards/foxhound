import type { ManualActionOutcome } from "./manual-actions.server";

// The CLIENT-SAFE half of S6 bulk actions (274 decisions one, four and five).
//
// This module is deliberately NOT `.server`, because the payments list renders
// the result surface in the browser and needs isBulkRefusal, orderForDisplay
// and failedIds there. A `.server` module is stripped from the client bundle,
// so putting these next to the fan-out would have typechecked and then failed
// in a browser. Everything here is pure: no db, no bindings, no fetch. The only
// import is a TYPE, which erases. Ruling 276 codified that the suite is a
// truncated instrument for this and the built bundle is the one that sees it.
//
// The fan-out itself (mapWithConcurrency, runBulkAction) stays in
// bulk-actions.server.ts, where it belongs.

/**
 * The intents a BULK submission may carry.
 *
 * Legacy's bulk set is exactly three of the five the dispatcher wires: trigger,
 * recover and cancel, fanned out over the same single-payment routes (scope
 * 1.5). Note and resend have no bulk affordance in legacy and none here.
 *
 * THIS LIST IS A GATE, NOT A CATALOG, and Session 3 added it because Session 2
 * did not have one. The bulk POST target passes its intent straight to the
 * dispatcher, which accepts all five, so before this existed a hand crafted POST
 * carrying intent=resend reached the SEND SEAM once per selected payment. That
 * was MEASURED with the gate removed, not reasoned: one send per payment that
 * carries a previously sent email step, which is most of what an active list
 * shows. intent=note would likewise have blanked N notes. The ceiling bounded
 * how many; it could not bound which. Neither is reachable from the interface,
 * which is exactly why only a server-side allow-list closes it.
 */
export const BULK_ACTION_INTENTS = ["trigger", "mark_recovered", "cancel"] as const;
export type BulkActionIntent = (typeof BULK_ACTION_INTENTS)[number];

export function isBulkActionIntent(value: unknown): value is BulkActionIntent {
  return (BULK_ACTION_INTENTS as readonly unknown[]).includes(value);
}

/**
 * Why one payment in a bulk submission did not succeed.
 *
 * Every value maps 1:1 onto a dispatcher outcome, so the surface can say WHICH
 * refusal happened rather than folding them into a count (274 decision one).
 * Legacy reads only `res.ok`, so a 400, a 409 and a 502 are one number (scope
 * 1.6); this is the repair, and it is why the list grew when trigger arrived
 * rather than trigger's four extra statuses collapsing into "failed".
 *
 * The trigger-only values and their legacy status codes, per S7-PHASE2-SCOPE 1.4
 * and ruling 267:
 *   no_pending_step       400, nothing left to run
 *   unknown_step_type     400, a step type with no executor
 *   processing_paused     409, the account brake, measured in 276 as reachable
 *                         for trigger and ONLY trigger
 *   customer_unsubscribed 409, suppressed rather than sent
 *   send_retrying         503, the step is still retryable and the tick has it
 *   step_failed           502, the executor ran and the step did not land
 */
export type BulkFailureReason =
  | "not_found"
  | "not_active"
  | "already_resolved"
  | "write_failed"
  | "no_pending_step"
  | "unknown_step_type"
  | "processing_paused"
  | "customer_unsubscribed"
  | "send_retrying"
  | "step_failed"
  /** The dispatcher answered something this intent is not expected to produce.
   *  Kept as its own value rather than swallowed: an unexpected outcome is a
   *  finding, not a silent success. */
  | "unexpected";

export interface BulkItemResult {
  id: string;
  ok: boolean;
  reason: BulkFailureReason | null;
  /** What the dispatcher said beyond the verdict, where it said anything: the
   *  STORED step result on a trigger, the offending step type, the failure's own
   *  result string. Carried so the surface can report what actually happened to
   *  a payment instead of just that something did. Null when the outcome has no
   *  detail to give. */
  detail: string | null;
}

export interface BulkActionResult {
  intent: string;
  results: BulkItemResult[];
}

/** The submission was refused as a whole, before any payment was touched. */
export interface BulkActionRefusal {
  refused: "empty" | "over_ceiling" | "unknown_intent";
  /** How many ids were submitted, so the surface can name the exact number
   *  rather than saying "too many" (274 decision four: never silently
   *  truncated, and the ceiling is stated). */
  submitted: number;
  ceiling: number;
}

export function isBulkRefusal(value: BulkActionResult | BulkActionRefusal): value is BulkActionRefusal {
  return "refused" in value;
}

/**
 * Map one dispatcher outcome onto a per-item result.
 *
 * NOTHING IS FOLDED. Each refusal keeps its own name, and a success that carries
 * information carries it through: trigger's ok says which executor ran and what
 * the step actually STORED, which matters because the dispatcher's contract is
 * that the step RAN, not that the charge succeeded. A retry that stored a
 * declined result is a true ok with a detail that says so, and reporting it as a
 * flat success would be the fold this function exists to avoid.
 */
export function toItemResult(id: string, outcome: ManualActionOutcome): BulkItemResult {
  if (outcome.ok) {
    return {
      id,
      ok: true,
      reason: null,
      detail: outcome.intent === "trigger" ? outcome.result : null,
    };
  }
  switch (outcome.reason) {
    case "not_found":
    case "not_active":
    case "already_resolved":
    case "write_failed":
    case "no_pending_step":
    case "processing_paused":
    case "customer_unsubscribed":
    case "send_retrying":
      return { id, ok: false, reason: outcome.reason, detail: null };
    case "unknown_step_type":
      return { id, ok: false, reason: "unknown_step_type", detail: outcome.stepType };
    case "step_failed":
      return { id, ok: false, reason: "step_failed", detail: outcome.result };
    default:
      return { id, ok: false, reason: "unexpected", detail: null };
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
