import type { AttributionKind, DeclineCategory } from "~/lib/constants";

// Human-readable labels + status-taxonomy tones for the recovery surfaces.

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
  // Never billable (262 one).
  manual: "Manual",
};

export const FAILED_PAYMENT_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  recovered: "Recovered",
  failed_unrecovered: "Failed",
  cancelled: "Canceled",
  // 377(1). Phrased as the merchant's question ("who is working this right now") rather than as the
  // column value.
  stripe_retrying: "Stripe retrying",
};

export type Tone = "neutral" | "success" | "failure";

/** A status word's tone, with the one that only a badge wears: "purple"
 *  (win-back attribution only, DESIGN.md). */
export type BadgeTone = Tone | "purple";

/** Each tone as Capsomer's tag badge, in Foxhound's badge look (app.css):
 *  success and failure are states (ok, crit) whose words say the state, so
 *  they draw no glyph; neutral is the quiet label; purple the purple family. */
export const BADGE_PILL: Record<
  BadgeTone,
  { variant: "tag"; tone?: "ok" | "crit"; glyph?: false; family?: string }
> = {
  success: { variant: "tag", tone: "ok", glyph: false },
  failure: { variant: "tag", tone: "crit", glyph: false },
  neutral: { variant: "tag" },
  purple: { variant: "tag", family: "purple" },
};

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
 * The recovered payment's real lifecycle state, read from refunded_at / disputed_at
 * (app/db/billable.ts spine #3), NEVER from attribution_kind. Attribution is a factual label about
 * which Foxhound action, if any, preceded the payment; it asserts nothing about whether the money
 * stuck or whether the recovery is billable (that is app/db/billable.ts's predicate, rendered on
 * the 5d ledger, not derived here).
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
