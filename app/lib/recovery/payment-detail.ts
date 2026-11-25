/**
 * CLIENT-SAFE BY CONSTRUCTION: the route component calls these, so this module imports nothing from
 * a `.server` file.
 */

import { titleCase } from "@drdustinedwards/site-helpers/text";
import type { Tone as StatusTone } from "capsomer/react/status";

import type { AttributionKind } from "~/lib/constants";
import { ATTRIBUTION_KIND_LABELS, type Tone } from "~/lib/recovery/labels";

/** Foxhound's three tones as Capsomer's status tones. */
export const PILL_TONE: Record<Tone, StatusTone | undefined> = {
  success: "ok",
  failure: "crit",
  neutral: undefined,
};

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
  // A customer who won a dispute against the merchant is not charged again.
  retry_skipped_dispute_lost: "Skipped: lost dispute on record",
  cancelled: "Canceled",
  skipped_inactive: "Skipped",
  error: "Error",
};

export function stepResultWords(result: string | null, executed: boolean): string {
  if (!result && !executed) return "Pending";
  if (!result) return "Executed";
  return STEP_RESULT_WORDS[result] ?? titleCase(result);
}

export function declineValueClass(category: string): string {
  switch (category) {
    case "soft":
      return "fh-blue";
    case "network":
      return "fh-caution";
    case "expired":
      return "fh-brand";
    case "fraud":
      return "fh-red";
    default:
      return "fh-faint";
  }
}

export function statusValueClass(status: string): string {
  switch (status) {
    case "active":
      return "fh-brand";
    case "recovered":
      return "fh-green";
    case "failed_unrecovered":
      return "fh-red";
    default:
      return "fh-faint";
  }
}

export function recoveredViaWords(kind: AttributionKind): string {
  return kind === "manual" ? "manually marked" : ATTRIBUTION_KIND_LABELS[kind];
}

/** Stop recovery keeps its approved word. */
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

export function visibleActionResult(input: {
  actionData: unknown;
  pendingIntent: unknown;
}): ActionResult | null {
  const { actionData, pendingIntent } = input;
  if (isDetailActionIntent(pendingIntent)) return null;
  if (!actionData || typeof actionData !== "object") return null;
  if ("error" in actionData && typeof actionData.error === "string")
    return { tone: "crit", message: actionData.error };
  if ("notice" in actionData && typeof actionData.notice === "string") {
    return { tone: "ok", message: actionData.notice };
  }
  return null;
}

// Manual per-payment actions: all five commit through the per-account money-write DO. Mark as recovered enters through the spine's buildRecoveryBatch and is never a second writer of recovered_payments.

/** The hold on a success message before it clears. An error stays until the next action. */
export const ACTION_SUCCESS_CLEAR_MS = 2000;

/** The hold on "Saved" beside Save note. */
export const NOTE_SAVED_CLEAR_MS = 2000;

/** A result that clears on its own: a success notice (an error stays). */
export function isNotice(result: object): boolean {
  return "notice" in result;
}

// The action set: trigger the next step, mark recovered, stop the sequence, resend the last email. "Stop recovery", not "Cancel recovery".
export const MANUAL_ACTIONS = [
  { intent: "trigger", label: "Trigger next step now", variant: "primary", needs: "nextStep" },
  { intent: "mark_recovered", label: "Mark as recovered", variant: "default", needs: null },
  { intent: "cancel", label: "Stop recovery", variant: "danger", needs: null },
  { intent: "resend", label: "Resend last email", variant: "default", needs: "lastEmail" },
] as const;

// NO action buttons render in a terminal state; the gate is `payment.status === 'active'`.
export const ACTIONS_VISIBLE_STATUS = "active";

export const BACK_LINK_REAL = { href: "/recovery/dashboard", label: "Back to dashboard" };
export const BACK_LINK_DEMO = { href: "/recovery/payments", label: "Back to payments" };

/** The demo title on every control that needs a Stripe account. */
export const DEMO_DISABLED_REASON = "Connect Stripe to use this";
