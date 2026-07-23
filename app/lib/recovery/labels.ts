import type { AttributionKind, DeclineCategory } from "~/lib/constants";

// Human-readable labels + status-taxonomy tones for the recovery surfaces
// (Phase 5 slice 5b). Pure so the mapping is unit-tested and reused across the
// payment list, payment detail, and sequences views. Amber is reserved (DESIGN.md:
// the action color, one per card); none of these tones use it. Purple is
// reserved exclusively for win-back attribution (see winback-labels usage).

export const DECLINE_CATEGORY_LABELS: Record<DeclineCategory, string> = {
  soft: "Soft decline",
  network: "Network error",
  expired: "Expired card",
  fraud: "Suspected fraud",
  revoked: "Revoked authorization",
  unknown: "Unclassified decline",
};

export const ATTRIBUTION_KIND_LABELS: Record<AttributionKind, string> = {
  foxhound_retry: "Foxhound retry",
  email_engaged: "Email engaged",
  card_update: "Card update",
  stripe_baseline: "Stripe baseline",
};

export const FAILED_PAYMENT_STATUS_LABELS: Record<string, string> = {
  active: "In recovery",
  recovered: "Recovered",
  failed_unrecovered: "Not recovered",
};

// Values match Badge's BadgeTone (app/components/badge.tsx) so callers pass
// these straight through as the `tone` prop with no translation layer.
export type Tone = "neutral" | "success" | "failure";

const STEP_RESULT_TONE: Record<string, Tone> = {
  retry_succeeded: "success",
  email_sent: "success",
  card_updated: "success",
  retry_card_declined: "failure",
  retry_error: "failure",
  retry_failed: "failure",
  email_failed: "failure",
};

/** A step with no result yet is neutral (pending); an unrecognized result also
 *  reads neutral rather than crashing the timeline on an unexpected value. */
export function stepResultTone(result: string | null): Tone {
  if (!result) return "neutral";
  return STEP_RESULT_TONE[result] ?? "neutral";
}

/** "recovered" is success, "failed_unrecovered" is a terminal failure, "active"
 *  (still in progress) is neutral, never amber (amber is reserved, DESIGN.md). */
export function failedPaymentStatusTone(status: string): Tone {
  if (status === "recovered") return "success";
  if (status === "failed_unrecovered") return "failure";
  return "neutral";
}

export interface RecoveryLifecycleInput {
  refundedAt: Date | null;
  disputedAt: Date | null;
}

export const RECOVERY_LIFECYCLE_LABELS = {
  refunded: "Refunded",
  disputed: "Disputed",
  recovered: "Recovered",
} as const;
export type RecoveryLifecycleStatus = keyof typeof RECOVERY_LIFECYCLE_LABELS;

/**
 * The recovered payment's real lifecycle state, read from refunded_at /
 * disputed_at (app/db/billable.ts spine #3), NEVER from attribution_kind.
 * Attribution is a factual label about which Foxhound action, if any,
 * preceded the payment; it asserts nothing about whether the money stuck or
 * whether the recovery is billable (that is app/db/billable.ts's predicate,
 * rendered on the 5d ledger, not derived here). A refunded or disputed
 * recovery must never read as a clean win, regardless of its attribution.
 */
export function recoveryLifecycleStatus(recovery: RecoveryLifecycleInput): RecoveryLifecycleStatus {
  if (recovery.refundedAt) return "refunded";
  if (recovery.disputedAt) return "disputed";
  return "recovered";
}

export function recoveryLifecycleTone(recovery: RecoveryLifecycleInput): Tone {
  return recoveryLifecycleStatus(recovery) === "recovered" ? "success" : "failure";
}

/** "retry_early" -> "Retry (early)"; "email_day3" -> "Email (day 3)";
 *  "card_update" -> "Card update" (the customer-initiated /p/:token signal,
 *  not a scheduled step, so it reads as a plain label, not a "(detail)"). */
export function formatStepType(stepType: string): string {
  if (stepType === "card_update") return "Card update";
  const [kind, ...rest] = stepType.split("_");
  const kindLabel = kind === "retry" ? "Retry" : kind === "email" ? "Email" : kind;
  const detail = rest.join(" ").replace(/day(\d+)/, "day $1");
  return detail ? `${kindLabel} (${detail})` : kindLabel;
}

/** "retry_card_declined" -> "Retry card declined". */
export function formatStepResult(result: string): string {
  return result
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
