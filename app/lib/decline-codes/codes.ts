import { classifyDecline, isRetryable } from "~/lib/recovery/decline";
import type { DeclineCategory } from "~/lib/constants";

// The seeded code list for the /decline-codes library (Phase 6 Pass 3). This
// is the union of TASK-foxhound-phase6.md's explicitly named codes
// (generic_decline, insufficient_funds, expired_card, do_not_honor,
// card_velocity_exceeded, incorrect_cvc, processing_error, fraudulent,
// lost_card, stolen_card) and every code already present in
// app/lib/recovery/decline.ts's four classification sets (SOFT_CODES,
// NETWORK_CODES, EXPIRED_CODES, FRAUD_CODES). 24 codes total.
//
// This module never hand-assigns a category. card_velocity_exceeded and
// incorrect_cvc are NOT in any of decline.ts's sets today, so
// classifyDecline() falls through to its documented safe default ("soft")
// for them; that is read live below via getDeclineCodeView, the same as
// every other code, so the marketing copy can never drift from what the
// recovery engine actually does. Do NOT edit app/lib/recovery/decline.ts to
// backfill a bespoke category for these two: the honest fact that they ride
// the safe-default path is stated plainly on their pages instead.
export interface DeclineCodeMeta {
  code: string;
  displayName: string;
}

export const DECLINE_CODES: DeclineCodeMeta[] = [
  // SOFT_CODES
  { code: "insufficient_funds", displayName: "Insufficient Funds" },
  { code: "do_not_honor", displayName: "Do Not Honor" },
  { code: "generic_decline", displayName: "Generic Decline" },
  { code: "card_declined", displayName: "Card Declined" },
  { code: "transaction_not_allowed", displayName: "Transaction Not Allowed" },
  { code: "withdrawal_count_limit_exceeded", displayName: "Withdrawal Count Limit Exceeded" },
  // NETWORK_CODES
  { code: "processing_error", displayName: "Processing Error" },
  { code: "card_error", displayName: "Card Error" },
  { code: "issuer_not_available", displayName: "Issuer Not Available" },
  { code: "try_again_later", displayName: "Try Again Later" },
  { code: "service_unavailable", displayName: "Service Unavailable" },
  { code: "card_not_supported", displayName: "Card Not Supported" },
  { code: "reenter_transaction", displayName: "Reenter Transaction" },
  // EXPIRED_CODES
  { code: "expired_card", displayName: "Expired Card" },
  { code: "invalid_expiry_month", displayName: "Invalid Expiry Month" },
  { code: "invalid_expiry_year", displayName: "Invalid Expiry Year" },
  // FRAUD_CODES
  { code: "fraudulent", displayName: "Fraudulent" },
  { code: "lost_card", displayName: "Lost Card" },
  { code: "stolen_card", displayName: "Stolen Card" },
  { code: "pickup_card", displayName: "Pickup Card" },
  { code: "restricted_card", displayName: "Restricted Card" },
  { code: "security_violation", displayName: "Security Violation" },
  // Named in the task, not in any decline.ts set (safe-default "soft" path)
  { code: "card_velocity_exceeded", displayName: "Card Velocity Exceeded" },
  { code: "incorrect_cvc", displayName: "Incorrect CVC" },
];

export interface DeclineCodeView extends DeclineCodeMeta {
  category: DeclineCategory;
  retryable: boolean;
  /** True for the two named codes with no dedicated bucket in decline.ts. */
  ridesSafeDefault: boolean;
}

const CLASSIFIED_CODES = new Set([
  "insufficient_funds",
  "do_not_honor",
  "generic_decline",
  "card_declined",
  "transaction_not_allowed",
  "withdrawal_count_limit_exceeded",
  "processing_error",
  "card_error",
  "issuer_not_available",
  "try_again_later",
  "service_unavailable",
  "card_not_supported",
  "reenter_transaction",
  "expired_card",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "fraudulent",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "security_violation",
]);

function toView(meta: DeclineCodeMeta): DeclineCodeView {
  const category = classifyDecline(meta.code);
  return {
    ...meta,
    category,
    retryable: isRetryable(category),
    ridesSafeDefault: !CLASSIFIED_CODES.has(meta.code),
  };
}

export function listDeclineCodeViews(): DeclineCodeView[] {
  return DECLINE_CODES.map(toView);
}

export function getDeclineCodeView(code: string): DeclineCodeView | null {
  const meta = DECLINE_CODES.find((c) => c.code === code);
  return meta ? toView(meta) : null;
}

export const CATEGORY_LABEL: Record<DeclineCategory, string> = {
  soft: "Soft decline",
  network: "Network / processing",
  expired: "Expired card",
  fraud: "Fraud / security",
};

export const CATEGORY_ORDER: DeclineCategory[] = ["soft", "network", "expired", "fraud"];
