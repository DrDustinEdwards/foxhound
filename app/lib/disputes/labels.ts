import { humanize } from "@drdustinedwards/site-helpers/text";
import type { DisputeState } from "~/lib/constants";
import type { Tone } from "~/lib/recovery/labels";
import { DAY_MS } from "~/lib/constants";

export const DISPUTE_STATE_LABELS: Record<DisputeState, string> = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  submitted: "Submitted",
  resolved_won: "Won",
  resolved_lost: "Lost",
  inquiry_closed: "Inquiry closed",
};

export const RESOLVED_DISPUTE_STATES: readonly DisputeState[] = [
  "resolved_won",
  "resolved_lost",
  "inquiry_closed",
];

/**
 * Whether a Stripe dispute status is an inquiry's (warning_needs_response,
 * warning_under_review, warning_closed). An inquiry is the issuer asking about
 * a charge before any chargeback: it moves no money and is never won or lost.
 */
export function isInquiryStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && status.startsWith("warning_");
}

export const SUBMITTED_EXTERNALLY = "merchant_or_stripe";

export const SUBMITTED_AUTOMATICALLY = "foxhound_auto";

export interface DisputeListStatusInput {
  state: string;
  submittedBy: string | null;
  hasEvidence: boolean;
  stripeStatus?: string | null;
}

/**
 * Never shown, because Foxhound records neither: "Stripe handling" (Smart
 * Disputes availability is not tracked) and "Accepted" (a dispute closed as
 * charge_refunded does not resolve Foxhound's state machine).
 */
export function disputeListStatus(input: DisputeListStatusInput): { label: string; tone: Tone } {
  if (input.state === "inquiry_closed")
    return { label: DISPUTE_STATE_LABELS.inquiry_closed, tone: "neutral" };
  if (
    isInquiryStatus(input.stripeStatus) &&
    input.state !== "submitted" &&
    !isDisputeResolved(input.state)
  ) {
    return { label: "Inquiry", tone: "neutral" };
  }
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
      return {
        label: input.hasEvidence ? "Evidence ready" : DISPUTE_STATE_LABELS[input.state],
        tone: "neutral",
      };
    case "draft":
      return { label: DISPUTE_STATE_LABELS.draft, tone: "neutral" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}

/**
 * Accepts a plain string (a raw DB read is not statically narrowed to
 * DisputeState even though the CHECK constraint guarantees membership).
 */
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
 */
export function humanizeDisputeReason(reason: string | null): string {
  if (!reason) return "Unknown";
  const mapped = DISPUTE_REASON_LABELS[reason];
  if (mapped) return mapped;
  return humanize(reason) || "Unknown";
}

/**
 * Whole days until `deadline`, rounded up. Null passes through so a dispute
 * with no deadline renders nothing rather than a bogus count.
 */
export function daysUntilDeadline(deadline: Date | null, nowMs: number): number | null {
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - nowMs) / DAY_MS);
}

export type DeadlineUrgency = "overdue" | "urgent" | "soon" | "normal";

/**
 * The two deadline bands, named so the /product/disputes copy states the
 * numbers the dashboard colors by rather than retyping them.
 */
export const DEADLINE_URGENT_DAYS = 3;
export const DEADLINE_SOON_DAYS = 7;

/** Urgency band for an evidence deadline. */
export function deadlineUrgency(daysRemaining: number | null): DeadlineUrgency {
  if (daysRemaining === null) return "normal";
  if (daysRemaining <= 0) return "overdue";
  if (daysRemaining <= DEADLINE_URGENT_DAYS) return "urgent";
  if (daysRemaining <= DEADLINE_SOON_DAYS) return "soon";
  return "normal";
}

const DEADLINE_CLASS_NAME: Record<DeadlineUrgency, string> = {
  overdue: "fh-error",
  urgent: "fh-error",
  soon: "fh-brand",
  normal: "fh-quiet",
};

export function deadlineClassName(urgency: DeadlineUrgency): string {
  return DEADLINE_CLASS_NAME[urgency];
}

/**
 * The deadline phrase a merchant reads: how long is left, or that it has
 * passed. Returns null when there is no deadline to describe.
 */
export function deadlineLabel(daysRemaining: number | null): string | null {
  if (daysRemaining === null) return null;
  if (daysRemaining <= 0) return "Deadline passed";
  if (daysRemaining === 1) return "1 day left";
  return `${daysRemaining} days left`;
}

export function deadlineShort(daysRemaining: number | null, resolved: boolean): string {
  if (resolved || daysRemaining === null) return "";
  return `${daysRemaining}d`;
}
