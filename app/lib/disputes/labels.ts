import type { DisputeState } from "~/lib/constants";
import type { Tone } from "~/lib/recovery/labels";
import { DAY_MS } from "~/lib/constants";

// Human-readable labels + status-taxonomy tones for the disputes surfaces
// (Phase 5 slice 5c). Pure and unit-tested, mirroring app/lib/recovery/labels.ts.
// Tone is shared from the recovery module rather than redefined (same 3-value
// subset of Badge's BadgeTone); resolved_won is the only success, resolved_lost
// the only failure, everything pre-resolution is neutral (the brand accent is reserved,
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

/** Who Recova's and Foxhound's stored submitted_by names when the merchant or
 *  Stripe, not Foxhound, sent the evidence (the timeline reads it the same way). */
export const SUBMITTED_EXTERNALLY = "merchant_or_stripe";

export interface DisputeListStatusInput {
  state: string;
  submittedBy: string | null;
  /** Whether Foxhound's draft holds at least one non-blank evidence field. */
  hasEvidence: boolean;
}

/**
 * The disputes list's status, in Recova's words where one is true of the row
 * (Dustin, PR #75 question 1: "yes ro all", 2026-10-15,
 * cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6). Recova's nine, from
 * DisputesDashboardView.tsx (blob 3c1b7a98) deriveRecovaStatus:
 *
 * - Won, Lost: resolved_won, resolved_lost.
 * - We submitted / Submitted externally: submitted, split on the stored
 *   submitted_by exactly as Recova split it.
 * - Evidence ready: pending_review or approved, once the draft holds evidence.
 *   Foxhound drafts at intake, so the draft is finished and waiting on the
 *   merchant, which is what Recova's staged_at meant.
 *
 * No Recova word is true of these, so they keep Foxhound's own label:
 * - pending_review or approved with a blank draft: nothing is ready, and nothing in
 *   Foxhound is still building it, so neither "Evidence ready" nor
 *   "Building evidence" holds.
 * - draft: no Foxhound code writes it and nothing builds its evidence.
 *
 * Never shown, because Foxhound records neither: "Stripe handling" (Smart
 * Disputes availability is not tracked) and "Accepted" (a dispute closed as
 * charge_refunded does not resolve Foxhound's state machine). "Unknown" is the
 * fallback for a state outside the six, as Recova's is.
 */
export function disputeListStatus(input: DisputeListStatusInput): { label: string; tone: Tone } {
  switch (input.state) {
    case "resolved_won":
      return { label: "Won", tone: "success" };
    case "resolved_lost":
      return { label: "Lost", tone: "failure" };
    case "submitted":
      return {
        label: input.submittedBy === SUBMITTED_EXTERNALLY ? "Submitted externally" : "We submitted",
        tone: "neutral",
      };
    case "pending_review":
    case "approved":
      return { label: input.hasEvidence ? "Evidence ready" : DISPUTE_STATE_LABELS[input.state], tone: "neutral" };
    case "draft":
      return { label: DISPUTE_STATE_LABELS.draft, tone: "neutral" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}

/** Accepts a plain string (a raw DB read is not statically narrowed to
 *  DisputeState even though the CHECK constraint guarantees membership). */
export function isDisputeResolved(state: string): boolean {
  return (RESOLVED_DISPUTE_STATES as readonly string[]).includes(state);
}

// Stripe's dispute reason codes, as a merchant should read them. Without this
// the surfaces rendered the raw enum, so a merchant reviewing a chargeback saw
// "product_not_received" in a column headed Reason.
const DISPUTE_REASON_LABELS: Record<string, string> = {
  bank_cannot_process: "Bank cannot process",
  check_returned: "Check returned",
  credit_not_processed: "Credit not processed",
  customer_initiated: "Customer initiated",
  debit_not_authorized: "Debit not authorized",
  duplicate: "Duplicate",
  fraudulent: "Fraudulent",
  general: "General",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  product_not_received: "Product not received",
  product_unacceptable: "Product unacceptable",
  subscription_canceled: "Subscription canceled",
  unrecognized: "Unrecognized",
};

/**
 * A dispute reason in sentence case. Unmapped codes are de-underscored and
 * sentence-cased rather than dropped, because Stripe adds reason codes and a
 * blank cell is worse than an imperfect label.
 *
 * Legacy's equivalent capitalized the first character and then replaced
 * underscores only in the REST of the string, so a code with a leading
 * underscore kept it. This handles the whole string.
 */
export function humanizeDisputeReason(reason: string | null): string {
  if (!reason) return "Unknown";
  const mapped = DISPUTE_REASON_LABELS[reason];
  if (mapped) return mapped;
  const spaced = reason.replace(/_/g, " ").trim();
  if (!spaced) return "Unknown";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whole days until `deadline`, rounded up. Null passes through so a dispute
 *  with no deadline renders nothing rather than a bogus count. */
export function daysUntilDeadline(deadline: Date | null, nowMs: number): number | null {
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - nowMs) / DAY_MS);
}

export type DeadlineUrgency = "overdue" | "urgent" | "soon" | "normal";

/** The two deadline bands, named so the /product/disputes copy states the
 *  numbers the dashboard colours by rather than retyping them (RULES.md 2.1). */
export const DEADLINE_URGENT_DAYS = 3;
export const DEADLINE_SOON_DAYS = 7;

/** Urgency band for an evidence deadline. Legacy toned at 3 and 7 days; those
 *  boundaries are kept because they track how banks actually work (a Stripe
 *  evidence window is typically 7 to 21 days, so inside 3 days is genuinely
 *  last-chance). */
export function deadlineUrgency(daysRemaining: number | null): DeadlineUrgency {
  if (daysRemaining === null) return "normal";
  if (daysRemaining <= 0) return "overdue";
  if (daysRemaining <= DEADLINE_URGENT_DAYS) return "urgent";
  if (daysRemaining <= DEADLINE_SOON_DAYS) return "soon";
  return "normal";
}

const DEADLINE_CLASS_NAME: Record<DeadlineUrgency, string> = {
  overdue: "text-error-text",
  urgent: "text-error-text",
  soon: "text-caution",
  normal: "text-text-tertiary",
};

export function deadlineClassName(urgency: DeadlineUrgency): string {
  return DEADLINE_CLASS_NAME[urgency];
}

/** The deadline phrase a merchant reads: how long is left, or that it has
 *  passed. Returns null when there is no deadline to describe. */
export function deadlineLabel(daysRemaining: number | null): string | null {
  if (daysRemaining === null) return null;
  if (daysRemaining <= 0) return "Deadline passed";
  if (daysRemaining === 1) return "1 day left";
  return `${daysRemaining} days left`;
}

/** The deadline as Recova's disputes list shows it (DisputesDashboardView,
 *  blob 3c1b7a98): whole days left as "18d", and blank once the dispute is
 *  resolved or when there is no deadline. A passed deadline reads "-2d", as
 *  Recova's does; the detail page keeps the longer deadlineLabel. */
export function deadlineShort(daysRemaining: number | null, resolved: boolean): string {
  if (resolved || daysRemaining === null) return "";
  return `${daysRemaining}d`;
}
