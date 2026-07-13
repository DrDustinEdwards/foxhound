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

// ---- AI models (ARCHITECTURE.md: Sonnet generates, Haiku scores) ----
// One place holds every model id. Phase 4e owns the ai_calls cost map that must
// cover each id here (closes legacy R-49 drift); Phase 4b uses generation only.
/** Recovery / dunning copy generation. */
export const MODEL_RECOVERY_EMAIL = "claude-sonnet-5";
/** Cheap quality/scoring gate on generated copy. */
export const MODEL_EMAIL_QUALITY = "claude-haiku-4-5-20251001";

// ---- Recovery step timing (hours from failure detection) ----
// Rebuild ordering is SILENT-FIRST (PRICING.md): for retryable declines a silent
// Foxhound retry precedes the first customer-facing email, so we never dun a
// customer a payment we could have quietly recovered. Every dunning email also
// carries the hosted card-update link (/p/:token), so the card-updater is a
// passive channel on every email rather than a separate step.
export const STEP_TIMING_RETRY_EARLY_HOURS = 4;
export const STEP_TIMING_RETRY_4HR_HOURS = 4;
export const STEP_TIMING_EMAIL_DAY1_HOURS = 24;
export const STEP_TIMING_RETRY_DAY2_HOURS = 48;
export const STEP_TIMING_EMAIL_DAY3_HOURS = 72;
export const STEP_TIMING_EMAIL_DAY7_HOURS = 168;
export const STEP_TIMING_EMAIL_DAY14_HOURS = 336;
export const STEP_TIMING_RETRY_DAY21_HOURS = 504;
export const STEP_TIMING_EMAIL_DAY30_HOURS = 720;
export const STEP_TIMING_FRAUD_EMAIL_DAY1_HOURS = 2;

// ---- Win-back timing (hours from cancellation) ----
export const WINBACK_STEP1_HOURS = 24;
export const WINBACK_STEP2_HOURS = 72;
export const WINBACK_STEP3_HOURS = 168;

// ---- Send-attempt retry (transient send failures; SCHEMA.md recovery_steps state) ----
export const SEND_MAX_ATTEMPTS = 3;
/** Backoff minutes indexed by (attempt_count - 1); last value repeats. */
export const SEND_RETRY_BACKOFF_MINUTES = [5, 30, 120] as const;

// ---- Decline classification (rebuild is silent-first; fraud never retries) ----
export const DECLINE_CATEGORIES = ["soft", "network", "expired", "fraud"] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

// ---- Email pipeline (ARCHITECTURE.md: Cloudflare Email Service, one send module) ----
/** Authenticated send domain (warmed independently of Worker routing). */
export const EMAIL_SEND_DOMAIN = "send.foxhoundapp.com";
/** Envelope From address for merchant dunning copy (merchant display name is prefixed per send). */
export const EMAIL_FROM_ADDRESS = `recovery@${EMAIL_SEND_DOMAIN}`;
/** Public utility path bases for CAN-SPAM one-click unsubscribe and the hosted card-update page. */
export const UNSUBSCRIBE_PATH = "/u";
export const CARD_UPDATE_PATH = "/p";
/** Engagement tracking path bases (first-party open pixel + click redirect). */
export const ENGAGEMENT_OPEN_PATH = "/e/o";
export const ENGAGEMENT_CLICK_PATH = "/e/c";
/** Queue consumer retry ceiling before dead-letter (mirrors the wrangler consumer config). */
export const EMAIL_QUEUE_MAX_RETRIES = 3;
/** Queue names (batch.queue switch in the consumer; Dustin creates queues with these names). */
export const EMAIL_QUEUE_NAME = "foxhound-email";
export const EMAIL_EVENTS_QUEUE_NAME = "foxhound-email-events";

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
