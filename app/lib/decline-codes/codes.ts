import { classifyDecline, isRetryable } from "~/lib/recovery/decline";
import type { DeclineCategory } from "~/lib/constants";

// The seeded code list for the /decline-codes library. Synced to the full
// 32-code set researched in recova/phase6-content-decline-codes.md, plus
// card_error (present in decline.ts's NETWORK_CODES but not covered by that
// content doc; card_error's copy is hand-written in content.ts, grounded in
// ordinary payments-industry knowledge, matching the doc's tone).
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
  { code: "revocation_of_authorization", displayName: "Revocation of Authorization" },
  { code: "do_not_try_again", displayName: "Do Not Try Again" },
  // Not in any decline.ts set; rides the "unknown" fail-closed default
  { code: "card_velocity_exceeded", displayName: "Card Velocity Exceeded" },
  { code: "incorrect_cvc", displayName: "Incorrect CVC" },
  { code: "invalid_cvc", displayName: "Invalid CVC" },
  { code: "incorrect_number", displayName: "Incorrect Number" },
  { code: "invalid_number", displayName: "Invalid Number" },
  { code: "no_action_taken", displayName: "No Action Taken" },
  { code: "currency_not_supported", displayName: "Currency Not Supported" },
  { code: "call_issuer", displayName: "Call Issuer" },
  { code: "duplicate_transaction", displayName: "Duplicate Transaction" },
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
  "revocation_of_authorization",
  "do_not_try_again",
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

export const DECLINE_CODES_PATH = "/decline-codes";

// A code's page address joins words with hyphens (Google's URL guide); the code keeps its underscores everywhere else.
const declineCodeSlug = (code: string): string => code.replaceAll("_", "-");

export const declineCodePath = (code: string): string =>
  `${DECLINE_CODES_PATH}/${declineCodeSlug(code)}`;

export function getDeclineCodeView(slug: string): DeclineCodeView | null {
  const meta = DECLINE_CODES.find((c) => declineCodeSlug(c.code) === slug);
  return meta ? toView(meta) : null;
}

export const CATEGORY_LABEL: Record<DeclineCategory, string> = {
  soft: "Soft decline",
  network: "Network / processing",
  expired: "Expired card",
  fraud: "Fraud / security",
  revoked: "Revoked authorization",
  unknown: "Unclassified",
};

export const CATEGORY_ORDER: DeclineCategory[] = [
  "soft",
  "network",
  "expired",
  "fraud",
  "revoked",
  "unknown",
];
