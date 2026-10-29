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
  // On Stripe's own hard decline list: Stripe does not retry it until a new
  // payment method is detected. Recova filed it as soft and retried it; Dustin
  // moved it to the hard declines on 2026-10-25 (decision card, "Yes, all
  // three"), so it is never silently retried.
  "transaction_not_allowed",
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

/**
 * The most specific decline code among several readings of one failure, in the
 * caller's order of trust. Stripe's charge carries the generic "card_declined"
 * as its failure_code while the issuer's real reason sits in decline_code, so a
 * generic code yields to any specific one and is kept only when nothing else
 * was read. Pure.
 */
export function pickDeclineCode(candidates: (string | null | undefined)[]): string | null {
  const present = candidates.filter((c): c is string => !!c);
  return present.find((c) => c !== "card_declined") ?? present[0] ?? null;
}

/**
 * Let the card network's advice code override the category where it says more
 * than the decline code does. Only a decline the classifier would treat as
 * retryable or unreadable (soft, network, unknown) is moved: an expired, fraud
 * or revoked decline is already at least as strict.
 *
 * "do_not_try_again" takes the category the classifier gives the decline code
 * of the same name, so it is never silently retried. "confirm_card_data" means
 * the card details are wrong, which is the card-update path an expired card
 * takes. "try_again_later", and anything else, changes nothing. Pure.
 */
export function applyNetworkAdvice(
  category: DeclineCategory,
  adviceCode: string | null | undefined,
): DeclineCategory {
  if (category !== "soft" && category !== "network" && category !== "unknown") return category;
  if (adviceCode === "do_not_try_again") return classifyDecline("do_not_try_again");
  if (adviceCode === "confirm_card_data") return "expired";
  return category;
}
