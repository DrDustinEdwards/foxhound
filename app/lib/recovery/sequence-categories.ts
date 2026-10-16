import type { DeclineCategory } from "~/lib/constants";

import { RECOVERY_SCHEDULES } from "./schedule";

// The /recovery/sequence page's own words for each category (row S9, J12).
// Recova's page keeps its own category table (components/SequenceView.tsx at
// blob 5507b89f, CATEGORIES): plural names, its own order, and one sentence
// each. These follow it, on Foxhound's six categories and its silent-retry-
// first schedules (ruling 80). The shared singular labels in labels.ts stay as
// they are, because the payments list, the payment page, the dashboard and the
// CSV export render them too.

/** Recova's four in Recova's order (soft, expired, network, fraud), then
 *  Foxhound's two extra categories. */
export const SEQUENCE_CATEGORY_ORDER: readonly DeclineCategory[] = [
  "soft",
  "expired",
  "network",
  "fraud",
  "revoked",
  "unknown",
];

/** Recova's plural names; Foxhound's two extras follow the same pattern. */
export const SEQUENCE_CATEGORY_NAMES: Record<DeclineCategory, string> = {
  soft: "Soft declines",
  expired: "Expired cards",
  network: "Network errors",
  fraud: "Fraud flags",
  revoked: "Revoked authorizations",
  unknown: "Unclassified declines",
};

function offsetOf(category: DeclineCategory, stepType: string): number {
  const step = RECOVERY_SCHEDULES[category].find((s) => s.stepType === stepType);
  if (!step) throw new Error(`${category} has no ${stepType} step`);
  return step.offsetHours;
}

/**
 * Recova's sentences, with Foxhound's name, true against RECOVERY_SCHEDULES
 * (test/recovery-sequences-j12.test.ts checks each against the schedule).
 * Recova's soft sentence ("sends an email then retries the payment after 48
 * hours") describes its email-first cadence; Foxhound's soft schedule leads
 * with a silent retry (APPROVED-DIFFERENCES, "Silent retry comes before the
 * first email"), so the sentence says so, and the later retry's hours are read
 * from the schedule.
 */
export const SEQUENCE_CATEGORY_DESCRIPTIONS: Record<DeclineCategory, string> = {
  soft: `Insufficient funds and generic declines. Foxhound retries silently first, then sends an email and retries the payment again ${offsetOf("soft", "retry_day2")} hours after the failure.`,
  expired: "Expired card declines. Foxhound sends emails only. Retrying an expired card never succeeds.",
  network: "Processing errors and issuer timeouts. Foxhound retries first, then emails if retries fail.",
  fraud: "Fraud flags and security holds. Foxhound sends reassurance emails. Retries are not attempted.",
  revoked:
    "The customer revoked payment authorization. Foxhound sends one email offering to cancel or add a new payment method. Retries are not attempted.",
  unknown:
    "Decline codes Foxhound does not recognize. Foxhound sends emails only, on the same schedule as an expired card. Retries are not attempted.",
};

export type SequenceRateTone = "green" | "caution" | "red";

/** Recova's rateColor (SequenceView.tsx): open rate green above 50, caution
 *  from 20, red below; click rate (and a retry's success rate) green above 20,
 *  caution from 5, red below. */
export function sequenceRateTone(pct: number, kind: "open" | "click"): SequenceRateTone {
  const [green, caution] = kind === "open" ? [50, 20] : [20, 5];
  if (pct > green) return "green";
  if (pct >= caution) return "caution";
  return "red";
}

// Recova drew the middle band in its old accent colour, which Foxhound drops (Q11), so it
// takes the caution token the dashboard's rate bands use (app.css).
const RATE_CLASS_NAME: Record<SequenceRateTone, string> = {
  green: "text-success-text",
  caution: "text-caution",
  red: "text-error-text",
};

export function sequenceRateClassName(pct: number, kind: "open" | "click"): string {
  return RATE_CLASS_NAME[sequenceRateTone(pct, kind)];
}
