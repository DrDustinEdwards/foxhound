import type { DeclineCategory } from "~/lib/constants";

// Single source of truth for Stripe decline-code classification (ported from
// legacy lib/decline.ts). Decline category is first-class: it drives which
// recovery schedule runs (schedule.ts) and the tone of the dunning copy.
// Money-path fails CLOSED: an unrecognized / null code is "unknown", a
// dedicated no-auto-retry bucket, never folded into "soft".

const SOFT_CODES = new Set([
  "insufficient_funds",
  "do_not_honor",
  "generic_decline",
  "card_declined",
  "transaction_not_allowed",
  "withdrawal_count_limit_exceeded",
]);

const NETWORK_CODES = new Set([
  "processing_error",
  "card_error",
  "issuer_not_available",
  "try_again_later",
  "service_unavailable",
  "card_not_supported",
  "reenter_transaction",
]);

const EXPIRED_CODES = new Set([
  "expired_card",
  "invalid_expiry_month",
  "invalid_expiry_year",
]);

const FRAUD_CODES = new Set([
  "fraudulent",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "security_violation",
  // The network told us to stop for this charge with no path back: never retry,
  // route to the fraud dunning cadence (email-only, gentle).
  "do_not_try_again",
]);

// The cardholder has explicitly revoked their standing authorization (called
// their bank to block recurring charges from this merchant). This is neither a
// retryable soft decline nor a fraud flag: it is a deliberate stop. It gets its
// own single-email "cancel or update payment method?" hold, never a retry and
// never a multi-step dunning sequence (schedule.ts RECOVERY_SCHEDULES.revoked).
// Both the singular Stripe decline_code and the plural form map here.
const REVOKED_CODES = new Set([
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
]);

export function classifyDecline(code: string | null | undefined): DeclineCategory {
  if (!code) return "unknown";
  if (SOFT_CODES.has(code)) return "soft";
  if (NETWORK_CODES.has(code)) return "network";
  if (EXPIRED_CODES.has(code)) return "expired";
  if (REVOKED_CODES.has(code)) return "revoked";
  if (FRAUD_CODES.has(code)) return "fraud";
  return "unknown";
}

/** True for a category whose declines can be silently retried (soft/network). */
export function isRetryable(category: DeclineCategory): boolean {
  return category === "soft" || category === "network";
}
