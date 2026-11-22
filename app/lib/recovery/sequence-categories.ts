import type { DeclineCategory } from "~/lib/constants";

import { RECOVERY_SCHEDULES } from "./schedule";

// The /recovery/sequence page's own words for each category.

export const SEQUENCE_CATEGORY_ORDER: readonly DeclineCategory[] = [
  "soft",
  "expired",
  "network",
  "fraud",
  "revoked",
  "unknown",
];

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

export const SEQUENCE_CATEGORY_DESCRIPTIONS: Record<DeclineCategory, string> = {
  soft: `Insufficient funds and generic declines. Foxhound retries silently first, then sends an email and retries the payment again ${offsetOf("soft", "retry_day2")} hours after the failure.`,
  // Foxhound keeps that retry and charges only a card updated since the decline (Dustin), so the
  // sentence says what the engine does.
  expired: `Expired card declines. Foxhound sends emails, and retries on day ${offsetOf("expired", "retry_day21") / 24} only if the card has been updated. Retrying an unchanged expired card never succeeds.`,
  network:
    "Processing errors and issuer timeouts. Foxhound retries first, then emails if retries fail.",
  fraud:
    "Fraud flags and security holds. Foxhound sends reassurance emails. Retries are not attempted.",
  revoked:
    "The customer revoked payment authorization. Foxhound sends one email offering to cancel or add a new payment method. Retries are not attempted.",
  unknown:
    "Decline codes Foxhound does not recognize. Foxhound sends emails only, on the same days as the expired card emails. Retries are not attempted.",
};

export type SequenceRateTone = "green" | "caution" | "red";

export function sequenceRateTone(pct: number, kind: "open" | "click"): SequenceRateTone {
  const [green, caution] = kind === "open" ? [50, 20] : [20, 5];
  if (pct > green) return "green";
  if (pct >= caution) return "caution";
  return "red";
}

const RATE_CLASS_NAME: Record<SequenceRateTone, string> = {
  green: "fh-success",
  caution: "fh-brand",
  red: "fh-error",
};

export function sequenceRateClassName(pct: number, kind: "open" | "click"): string {
  return RATE_CLASS_NAME[sequenceRateTone(pct, kind)];
}
