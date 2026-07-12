// Centralized constants (ARCHITECTURE.md non-negotiable #6: no hardcoded fees,
// timings, limits, or canon enum values scattered through business logic).
// Pricing values trace to docs/canon/PRICING.md; enum value sets mirror the
// CHECK constraints in app/db/schema.ts (kept in sync by hand; SCHEMA.md is canon).

// ---- Pricing (PRICING.md) ----
/** Recovery fee: 20% of Foxhound-attributed recoveries (pay-on-lift). */
export const RECOVERY_FEE_BPS = 2000;
/** Dispute fee: 20% of won disputes... */
export const DISPUTE_FEE_BPS = 2000;
/** ...capped at $250 per dispute. */
export const DISPUTE_FEE_CAP_CENTS = 25_000;
/** Intelligence predictive risk layer: $199/month. */
export const INTELLIGENCE_PRICE_CENTS = 19_900;

// ---- Maturity window (PRICING.md maturity-window billing) ----
/** A recovery is billable only once it is at least this old (refund window absorption). */
export const RECOVERY_MATURITY_DAYS = 30;
export const RECOVERY_MATURITY_MS = RECOVERY_MATURITY_DAYS * 24 * 60 * 60 * 1000;

// ---- Canon enum value sets (mirror schema CHECK constraints) ----
export const ATTRIBUTION_KINDS = [
  "foxhound_retry",
  "email_engaged",
  "card_update",
  "stripe_baseline",
] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/** Attribution kinds that make a recovery billable (everything except the free baseline). */
export const BILLABLE_ATTRIBUTION_KINDS = [
  "foxhound_retry",
  "email_engaged",
  "card_update",
] as const;

export const DISPUTE_STATES = [
  "draft",
  "pending_review",
  "approved",
  "submitted",
  "resolved_won",
  "resolved_lost",
] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

export const BILLING_LINE_ITEM_TYPES = [
  "recovery_fee",
  "dispute_fee",
  "subscription",
  "adjustment",
] as const;
export type BillingLineItemType = (typeof BILLING_LINE_ITEM_TYPES)[number];

export const ENGAGEMENT_EVENT_TYPES = ["open", "click"] as const;
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

// ---- Stripe (ARCHITECTURE.md: Stripe is the product; permanent dependency) ----
/**
 * Pinned Stripe API version. Matches the installed `stripe` package's default
 * (esm/apiVersion). Pinning here removes dependence on the Stripe account's
 * dashboard default so behavior is reproducible (non-negotiable #6).
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia";
/** Stripe Connect OAuth authorize endpoint. */
export const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/** Connect OAuth scope (read_write, legacy parity). */
export const STRIPE_CONNECT_SCOPE = "read_write";
/** CSRF state cookie name for the Connect OAuth flow. */
export const STRIPE_OAUTH_STATE_COOKIE = "stripe_oauth_state";
/** Connect OAuth state cookie lifetime: 10 minutes (legacy parity). */
export const STRIPE_OAUTH_STATE_TTL_SECONDS = 600;
