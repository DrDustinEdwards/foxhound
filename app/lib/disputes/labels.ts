import type { DisputeState } from "~/lib/constants";
import type { Tone } from "~/lib/recovery/labels";

// Human-readable labels + status-taxonomy tones for the disputes surfaces
// (Phase 5 slice 5c). Pure and unit-tested, mirroring app/lib/recovery/labels.ts.
// Tone is shared from the recovery module rather than redefined (same 3-value
// subset of Badge's BadgeTone); resolved_won is the only success, resolved_lost
// the only failure, everything pre-resolution is neutral (amber is reserved,
// DESIGN.md, and a dispute mid-review is not itself a success or a failure).

export const DISPUTE_STATE_LABELS: Record<DisputeState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  submitted: "Submitted",
  resolved_won: "Won",
  resolved_lost: "Lost",
};

export function disputeStateTone(state: DisputeState): Tone {
  if (state === "resolved_won") return "success";
  if (state === "resolved_lost") return "failure";
  return "neutral";
}

export const RESOLVED_DISPUTE_STATES: readonly DisputeState[] = ["resolved_won", "resolved_lost"];

/** Accepts a plain string (a raw DB read is not statically narrowed to
 *  DisputeState even though the CHECK constraint guarantees membership). */
export function isDisputeResolved(state: string): boolean {
  return (RESOLVED_DISPUTE_STATES as readonly string[]).includes(state);
}
