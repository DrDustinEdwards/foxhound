// Centralized constants (ARCHITECTURE.md non-negotiable #6: no hardcoded fees,
// timings, limits, or canon enum values scattered through business logic).
// Pricing values trace to docs/canon/PRICING.md; enum value sets mirror the
// CHECK constraints in app/db/schema.ts (kept in sync by hand; SCHEMA.md is canon).

// ---- Pricing (PRICING.md) ----
/** Recovery fee: 20% of Foxhound-attributed recoveries (pay-on-lift). */
export const RECOVERY_FEE_BPS = 2000;
/** Dispute fee: 20% of won disputes... */
export const DISPUTE_FEE_BPS = 2000;
/** ...capped at $500 per dispute (PRICING.md rev 3: anchored to value delivered,
 *  roughly 2x the median all-in cost of losing a dispute; binds only above a
 *  ~$2,500 disputed amount, the percentage governs below that). */
export const DISPUTE_FEE_CAP_CENTS = 50_000;
/** Intelligence predictive risk layer: $199/month. */
export const INTELLIGENCE_PRICE_CENTS = 19_900;

/**
 * Demo accounts are excluded from all billing (PRICING.md: demo data is re-seeded,
 * never billed). The demo-seeding system must create accounts whose id begins with
 * this prefix; real accounts use crypto.randomUUID ids, which never do. The billable
 * queries and the monthly run both filter on it.
 */
export const DEMO_ACCOUNT_ID_PREFIX = "demo_";

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

/**
 * Every model id the app may call. The ai_calls cost map (app/lib/ai/cost.ts)
 * MUST cover each (closes legacy R-49 drift: a model with no cost entry throws).
 * Cost lookup normalizes a trailing -YYYYMMDD date suffix to the canonical base
 * id, so both `claude-haiku-4-5` and `claude-haiku-4-5-20251001` resolve.
 */
export const AI_MODEL_IDS = [MODEL_RECOVERY_EMAIL, MODEL_EMAIL_QUALITY] as const;

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
// Revoked-authorization hold: a single email offering a clean cancel-or-update
// choice, sent soon after detection (the customer explicitly revoked, so we ask
// once rather than dun). This is the ONLY step for the `revoked` category.
export const STEP_TIMING_REVOKED_EMAIL_HOURS = 2;

// ---- Win-back timing (hours from cancellation) ----
export const WINBACK_STEP1_HOURS = 24;
export const WINBACK_STEP2_HOURS = 72;
export const WINBACK_STEP3_HOURS = 168;

// ---- Send-attempt retry (transient send failures; SCHEMA.md recovery_steps state) ----
export const SEND_MAX_ATTEMPTS = 3;
/** Backoff minutes indexed by (attempt_count - 1); last value repeats. */
export const SEND_RETRY_BACKOFF_MINUTES = [5, 30, 120] as const;

// ---- Decline classification (rebuild is silent-first; fraud never retries) ----
// "unknown" is the fail-closed default for any code not in an explicit set
// below: no auto-retry, same as fraud/expired (app/lib/recovery/decline.ts).
// "revoked" is the customer explicitly revoking authorization: one email
// offering a cancel-or-update choice, then a hold (no retries, no dunning).
export const DECLINE_CATEGORIES = ["soft", "network", "expired", "fraud", "revoked", "unknown"] as const;
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

// ---- Cron Triggers + retention (ARCHITECTURE.md: all scheduled jobs are Cron
// Triggers; retention crons live before any table they govern takes writes) ----
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Max age of a /p/:token card-update link before it is treated as expired
 *  (mirrors the longest recovery step schedule, EMAIL_DAY30, so a link stays
 *  valid for the full life of the sequence that carries it). */
export const CARD_UPDATE_TOKEN_MAX_AGE_MS = 30 * DAY_MS;
/** Max time a single run may hold a per-cron DO lock before the lease lapses. */
export const CRON_LOCK_LEASE_MS = 5 * 60 * 1000;
/** Cron schedules (UTC). MUST match wrangler.jsonc triggers.crons exactly. */
export const CRON_SCHEDULE_DAILY = "0 3 * * *"; // 03:00 UTC, retention sweeps
export const CRON_SCHEDULE_MONTHLY = "0 4 1 * *"; // 04:00 UTC on the 1st, billing run
/** Recovery tick: sweeps due recovery_steps. Runs every 5 minutes because the
 *  shortest timer in the engine is the 5-minute first send-retry backoff
 *  (SEND_RETRY_BACKOFF_MINUTES[0]); a coarser cadence would lag that backoff. */
export const CRON_SCHEDULE_RECOVERY_TICK = "*/5 * * * *";
/** Max due steps a single recovery tick processes, so one run stays bounded and a
 *  backlog drains over successive ticks (mirrors RETENTION_SWEEP_LIMIT). */
export const RECOVERY_TICK_LIMIT = 500;
/** Retention windows (ARCHITECTURE.md retention table). Raw rows older than the
 *  window are swept; ai_calls aggregates to monthly before delete. */
export const RETENTION_ENGAGEMENT_DAYS = 180;
export const RETENTION_EMAIL_SENDS_DAYS = 180;
export const RETENTION_WEBHOOK_EVENTS_DAYS = 90;
export const RETENTION_HEALTH_SCORE_DAYS = 90;
export const RETENTION_CRON_HISTORY_DAYS = 90;
export const RETENTION_AI_CALLS_DAYS = 90;
export const RETENTION_SOCIAL_LEADS_DAYS = 180;
export const RETENTION_PAGE_404_DAILY_DAYS = 365;
/** Max raw rows a single retention tick sweeps per table (keeps a tick bounded;
 *  a large backlog drains over successive ticks). */
export const RETENTION_SWEEP_LIMIT = 5_000;

// ---- Audit product (Phase 6 Pass 3: full-audit lift-band data/query layer) ----
/** Trailing window the audit scans for failed/recovered invoices (legacy parity). */
export const AUDIT_LOOKBACK_DAYS = 90;
/** Bounded work per audit run: caps Stripe invoice pagination (mirrors RETENTION_SWEEP_LIMIT). */
export const AUDIT_MAX_INVOICES_SCANNED = 2000;

// ---- Intelligence deterministic engine (customer_context + mrr_snapshots) ----
/** Bounded work per sync run: caps how many of an account's Stripe customers
 *  are scanned in one tick (mirrors AUDIT_MAX_INVOICES_SCANNED / RETENTION_SWEEP_LIMIT).
 *  WITHIN one run, this is a real cursor bound: the Stripe SDK's async iterator
 *  auto-paginates through as many pages as it takes to reach this count, not
 *  just the first page. ACROSS runs there is no resumption cursor (nothing
 *  persists which customers were already seen), so an account over this count
 *  rescans the same newest-first set every run rather than eventually covering
 *  everyone; app/lib/intelligence/sync.server.ts's AccountSyncResult.truncated
 *  flag surfaces this in cron_run_history so it is visible, not silent. */
export const INTELLIGENCE_MAX_CUSTOMERS_SCANNED = 2000;
/** Bounded invoice history read per customer when reconstructing billing-terms
 *  observations and payment-latency drift. */
export const INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER = 24;
/** Bounded charge history read per customer for refund/dispute counts. */
export const INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER = 100;

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
