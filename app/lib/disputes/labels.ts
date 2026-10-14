import type { DisputeState } from "~/lib/constants";
import type { Tone } from "~/lib/recovery/labels";

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
  return Math.ceil((deadline.getTime() - nowMs) / (24 * 60 * 60 * 1000));
}

export type DeadlineUrgency = "overdue" | "urgent" | "soon" | "normal";

/** Urgency band for an evidence deadline. Legacy toned at 3 and 7 days; those
 *  boundaries are kept because they track how banks actually work (a Stripe
 *  evidence window is typically 7 to 21 days, so inside 3 days is genuinely
 *  last-chance). */
export function deadlineUrgency(daysRemaining: number | null): DeadlineUrgency {
  if (daysRemaining === null) return "normal";
  if (daysRemaining <= 0) return "overdue";
  if (daysRemaining <= 3) return "urgent";
  if (daysRemaining <= 7) return "soon";
  return "normal";
}

const DEADLINE_CLASS_NAME: Record<DeadlineUrgency, string> = {
  overdue: "text-error-text",
  urgent: "text-error-text",
  soon: "text-brand-text",
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
