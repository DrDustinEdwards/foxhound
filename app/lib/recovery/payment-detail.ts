/**
 * Recova's payment detail words and value colors, ported from
 * app/(app)/recovery/payments/[id]/PaymentDetailClient.tsx (blob 7f54aa45) and
 * lib/ui-display.ts (blob 35c4d676), both read whole (J76).
 *
 * CLIENT-SAFE BY CONSTRUCTION: the route component calls these, so this module
 * imports nothing from a `.server` file (RULES.md 4.5).
 */

import type { Tone as StatusTone } from "capsomer/react/status";

import type { AttributionKind } from "~/lib/constants";
import { ATTRIBUTION_KIND_LABELS, formatStepResult, type Tone } from "~/lib/recovery/labels";

/** Foxhound's three tones as Capsomer's status tones. Neutral has no tone, so
 *  the pill is a plain label with no glyph, as J75's list does. */
export const PILL_TONE: Record<Tone, StatusTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

/**
 * Recova's result chip words (getStepResultLabel), keyed on what Foxhound's
 * recovery engine writes. Recova splits a sent email into "(AI)" and
 * "(template)"; the recovery engine stores one value, `email_sent` (labels.ts
 * STEP_RESULT_TONE), so it takes the plain "Email sent". A value Recova has no
 * word for is shown in words (formatStepResult), never as the raw column value
 * (RULES.md 1.5).
 */
const STEP_RESULT_WORDS: Record<string, string> = {
  email_sent: "Email sent",
  email_failed: "Email failed",
  retry_succeeded: "Payment recovered",
  retry_card_declined: "Card declined",
  retry_failed: "Retry failed",
  retry_error: "Retry error",
  // An expired card's day 21 retry that did not charge (card-change.ts).
  retry_skipped_card_unchanged: "Skipped: card not updated",
  retry_skipped_unverified: "Skipped: card update not confirmed",
  cancelled: "Canceled",
  skipped_inactive: "Skipped",
  error: "Error",
};

export function stepResultWords(result: string | null, executed: boolean): string {
  if (!result && !executed) return "Pending";
  if (!result) return "Executed";
  return STEP_RESULT_WORDS[result] ?? formatStepResult(result);
}

/**
 * Recova's decline color on a card (getCategoryTextVar): soft blue, network
 * orange, fraud red. Recova's expired color was its accent, which is amber in
 * Foxhound. Categories Recova lacks take the subtle gray, as its default.
 */
export function declineValueClass(category: string): string {
  switch (category) {
    case "soft":
      return "text-blue";
    case "network":
      return "text-caution";
    case "expired":
      return "text-brand-text";
    case "fraud":
      return "text-red";
    default:
      return "text-text-subtle";
  }
}

/** Recova's status color for an amount (getStatusColor), its accent in amber. */
export function statusValueClass(status: string): string {
  switch (status) {
    case "active":
      return "text-brand-text";
    case "recovered":
      return "text-green";
    case "failed_unrecovered":
      return "text-red";
    default:
      return "text-text-subtle";
  }
}

/** The method words in Recova's success banner: "recovered via Stripe retry",
 *  "recovered via manually marked". Foxhound names a recovery by its
 *  attribution kind (labels.ts), so the manual case keeps Recova's phrase and
 *  the rest read through the same table the Email engagement card uses. */
export function recoveredViaWords(kind: AttributionKind): string {
  return kind === "manual" ? "manually marked" : ATTRIBUTION_KIND_LABELS[kind];
}

/** Recova's doAction labels, which its client turns into "<label> successful"
 *  and "<label> failed". Stop recovery keeps its approved word (2026-08-10). */
export const ACTION_LABELS = {
  trigger: "Step triggered",
  mark_recovered: "Marked recovered",
  cancel: "Recovery stopped",
  resend: "Email resent",
} as const;

export type DetailActionIntent = keyof typeof ACTION_LABELS;

export function isDetailActionIntent(value: unknown): value is DetailActionIntent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}

/**
 * Recova says "Step triggered successful" for every trigger, including a retry
 * the card declined. That would tell a merchant a payment went through when it
 * did not, so a retry that did not pay says so (a truthfulness fix, RULES.md
 * 1.2); every other success is Recova's sentence.
 */
export function actionSuccessNotice(
  intent: DetailActionIntent,
  trigger?: { action: "retry" | "email"; result: string },
): string {
  if (intent === "trigger" && trigger?.action === "retry" && trigger.result !== "retry_succeeded") {
    return trigger.result === "retry_card_declined"
      ? "Step triggered, but the card was declined."
      : "Step triggered, but the retry did not succeed.";
  }
  return `${ACTION_LABELS[intent]} successful`;
}

export interface ActionResult {
  tone: "ok" | "crit";
  message: string;
}

/**
 * The action result banner, as Recova shows it (PaymentDetailClient.tsx
 * doAction): pressing any of the four actions clears the previous result at
 * once (`setActionResult(null)` before the request), an error then stays until
 * the next press, and a success clears after its hold. pendingIntent is the
 * intent of the submission in flight; a note save is a fetcher, never here.
 */
export function visibleActionResult(input: {
  actionData: unknown;
  clearedFor: unknown;
  pendingIntent: unknown;
}): ActionResult | null {
  const { actionData, clearedFor, pendingIntent } = input;
  if (isDetailActionIntent(pendingIntent)) return null;
  if (!actionData || typeof actionData !== "object") return null;
  if ("error" in actionData && typeof actionData.error === "string") return { tone: "crit", message: actionData.error };
  if ("notice" in actionData && typeof actionData.notice === "string" && clearedFor !== actionData) {
    return { tone: "ok", message: actionData.notice };
  }
  return null;
}
