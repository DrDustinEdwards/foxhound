import type { AttributionKind, DeclineCategory } from "~/lib/constants";

// Human-readable labels + status-taxonomy tones for the recovery surfaces
// (Phase 5 slice 5b). Pure so the mapping is unit-tested and reused across the
// payment list, payment detail, and sequences views. The brand accent (amber) is reserved (DESIGN.md:
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
  // Legacy's own word, READ from PaymentDetailClient.tsx at blob 7f54aa45, which
  // renders `recovery_method === 'manual' ? 'Manual'`. Never billable (262 one).
  manual: "Manual",
};

export const FAILED_PAYMENT_STATUS_LABELS: Record<string, string> = {
  // ALL FOUR are legacy's own words, READ from its status tabs rather than
  // invented: app/(app)/recovery/payments/components/PaymentsFilters.tsx
  // STATUS_TABS carries All / Active / Recovered / Canceled / Failed.
  //
  // `active` and `failed_unrecovered` read "In recovery" and "Not recovered"
  // until 2026-08-14. Those renames were never ratified: PRIME DIRECTIVE item 3
  // was read in full and carries neither, and no ruling in any volume does, so
  // under item 3 they were unratified user-visible divergences and were
  // corrected toward legacy rather than defended. S6's row had carried them as
  // OPEN since the contents walk.
  //
  // LEGACY DISAGREES WITH ITSELF HERE and the disagreement is recorded rather
  // than harmonised. Its status TABS say "Failed", but its list-row badge
  // (PaymentRow.tsx) and its detail badge (PaymentDetailClient.tsx) both render
  // `{payment.status}` raw under CSS `capitalize`, so legacy's badges show the
  // column value and read "Failed_unrecovered". This table gives every surface
  // the tab word. Shipping a database enum to a merchant is a defect, and the
  // direction of that fix is a ruling, not a build session's default, so the
  // difference is REPORTED and legacy's raw-value rendering is not ported.
  active: "Active",
  recovered: "Recovered",
  failed_unrecovered: "Failed",
  cancelled: "Canceled",
  // 377(1). Not one of legacy's four tab words, because legacy has no such
  // state: it starts its sequence on the first failure, which is the defect
  // this status exists to fix. Phrased as the merchant's question ("who is
  // working this right now") rather than as the column value.
  stripe_retrying: "Stripe retrying",
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
  retry_no_connection: "failure",
  email_failed: "failure",
};

/** A step with no result yet is neutral (pending); an unrecognized result also
 *  reads neutral rather than crashing the timeline on an unexpected value. */
export function stepResultTone(result: string | null): Tone {
  if (!result) return "neutral";
  return STEP_RESULT_TONE[result] ?? "neutral";
}

/** "recovered" is success, "failed_unrecovered" is a terminal failure, "active"
 *  (still in progress) is neutral, never the brand accent (it is reserved, DESIGN.md). */
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

/** Merchant-facing words for why a click was not counted.
 *  Plain description, never a vendor name or an accusation: the merchant needs
 *  to know the click was not billed and why, not to adjudicate it. */
const CLICK_SUSPECT_LABELS: Record<string, string> = {
  too_fast: "opened by a scanner, too fast to be a person",
  honeypot: "an automated client followed every link",
};

export function clickSuspectLabel(reason: string): string {
  return CLICK_SUSPECT_LABELS[reason] ?? "not verified as a person";
}
