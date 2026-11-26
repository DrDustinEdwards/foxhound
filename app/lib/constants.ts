// No hardcoded fees, timings, limits or enum values in business logic. Enum sets mirror the CHECK constraints in app/db/schema/.

/** Recovery fee: 20% of Foxhound-attributed recoveries (pay-on-lift). */
export const RECOVERY_FEE_BPS = 2000;
/** Dispute fee: 20% of won disputes... */
export const DISPUTE_FEE_BPS = 2000;
/** ...capped at $500 per dispute. USD minor units; a non-USD cap is converted on the resolution day (dispute-cap.ts). */
export const DISPUTE_FEE_CAP_CENTS = 50_000;

/** The monthly billing cron ("0 4 1 * *") as the two fields /billing reads; here so client code needs no .server import. */
export const BILLING_RUN_DAY_OF_MONTH = 1;
export const BILLING_RUN_HOUR_UTC = 4;

/** Ceiling on charge attempts per platform fee invoice; the age cap below binds first. */
export const FEE_INVOICE_MAX_RETRY_ATTEMPTS = 4;
/** Age cap for the same; the sweep runs monthly, so this gives two or three retries, then give_up (max_age_exceeded). */
export const FEE_INVOICE_MAX_RETRY_AGE_DAYS = 90;

/** Demo accounts are excluded from all billing; demo seeding must create ids with this prefix. */
export const DEMO_ACCOUNT_ID_PREFIX = "demo_";

const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** How long before a recovery a click can still be its cause; outside it the recovery records as free `stripe_baseline`. */
export const EMAIL_ENGAGEMENT_WINDOW_DAYS = 14;
export const EMAIL_ENGAGEMENT_WINDOW_MS = EMAIL_ENGAGEMENT_WINDOW_DAYS * DAY_MS;

/** A recovery is billable only once it is this old (refund window). */
export const RECOVERY_MATURITY_DAYS = 30;
export const RECOVERY_MATURITY_MS = RECOVERY_MATURITY_DAYS * DAY_MS;

/** The in-recovery status: a sequence is running and manual actions apply. */
export const FAILED_PAYMENT_STATUS_ACTIVE = "active";

/** Terminal: every step ran without recovering. Written only by the tick's exhausted-sequence sweep. */
export const FAILED_PAYMENT_STATUS_UNRECOVERED = "failed_unrecovered";

/** Terminal: a merchant stopped the sequence. failed_payments.status has no CHECK, so this vocabulary alone enforces it. */
export const FAILED_PAYMENT_STATUS_CANCELLED = "cancelled";

/** Stripe's Smart Retries own this payment; Foxhound records it and plans nothing. The churn guard keys on this row. */
export const FAILED_PAYMENT_STATUS_STRIPE_RETRYING = "stripe_retrying";

/** Statuses of a live failed payment; one constant so the churn guard and intake dedupe widen together. */
export const LIVE_FAILED_PAYMENT_STATUSES = [
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
] as const;

/** Statuses a late invoice.payment_succeeded may still recover from: a customer who pays after exhaustion or "Stop recovery" has genuinely paid. */
export const RECOVERABLE_FAILED_PAYMENT_STATUSES = [
  "active",
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  FAILED_PAYMENT_STATUS_CANCELLED,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
] as const;

export const ATTRIBUTION_KINDS = [
  "foxhound_retry",
  "email_engaged",
  "card_update",
  "stripe_baseline",
  // Merchant-asserted; never billable.
  "manual",
] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/** Merchant-asserted attribution kind (also a recovery_method value). Never billable. */
export const MANUAL_ATTRIBUTION_KIND = "manual";

/** Attribution kinds that make a recovery billable. */
export const BILLABLE_ATTRIBUTION_KINDS = [
  "foxhound_retry",
  "email_engaged",
  "card_update",
] as const;

export type DisputeState =
  | "draft"
  | "pending_review"
  | "approved"
  | "submitted"
  | "resolved_won"
  | "resolved_lost"
  // A warning_* inquiry Stripe closed: no ruling, nothing billable.
  | "inquiry_closed";

// Evidence upload limits; the page's limits line is built from these.
/** Files per dispute. */
export const DISPUTE_EVIDENCE_MAX_FILES = 5;
/** Bytes per file (5 MB). */
export const DISPUTE_EVIDENCE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
/** Allowed evidence file types. */
export const DISPUTE_EVIDENCE_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;
export type DisputeEvidenceFileType = (typeof DISPUTE_EVIDENCE_ALLOWED_TYPES)[number];

export type BillingLineItemType =
  | "recovery_fee"
  | "dispute_fee"
  | "subscription"
  | "adjustment"
  | "credit";

// One place holds every model id; the ai_calls cost map must cover each id here.
/** Recovery / dunning copy generation. */
export const MODEL_RECOVERY_EMAIL = "claude-sonnet-5";
/** Unauthenticated home-page email sample generator. */
export const MODEL_MARKETING_EMAIL_SAMPLE = "claude-haiku-5-5";
/** The audit's three-sentence summary. */
export const MODEL_AUDIT_SUMMARY = "claude-haiku-5-5";
/** Token budget for the summary (three sentences). */
export const AUDIT_SUMMARY_MAX_TOKENS = 300;

// SILENT-FIRST (PRICING.md): for retryable declines a silent retry precedes the first customer email.
export const STEP_TIMING_RETRY_EARLY_HOURS = 4;
export const STEP_TIMING_RETRY_4HR_HOURS = 4;
export const STEP_TIMING_EMAIL_DAY1_HOURS = 1;
// SOFT: first email goes 1 hour after the silent retry.
export const STEP_TIMING_SOFT_EMAIL_DAY1_HOURS = STEP_TIMING_RETRY_EARLY_HOURS + 1;
export const STEP_TIMING_RETRY_DAY2_HOURS = 48;
export const STEP_TIMING_NETWORK_RETRY_DAY2_HOURS = 24;
export const STEP_TIMING_EMAIL_DAY3_HOURS = 72;
export const STEP_TIMING_NETWORK_EMAIL_DAY3_HOURS = 48;
export const STEP_TIMING_EMAIL_DAY7_HOURS = 168;
export const STEP_TIMING_EMAIL_DAY14_HOURS = 336;
export const STEP_TIMING_RETRY_DAY21_HOURS = 504;
export const STEP_TIMING_EMAIL_DAY30_HOURS = 720;
export const STEP_TIMING_FRAUD_EMAIL_DAY1_HOURS = 2;
// Revoked: one cancel-or-update email, the ONLY step.
export const STEP_TIMING_REVOKED_EMAIL_HOURS = 2;

// Schedule: 1h, 96h, 336h; the window is 14 days (step 3).
export const WINBACK_STEP1_HOURS = 1;
export const WINBACK_STEP2_HOURS = 96;
export const WINBACK_STEP3_HOURS = 336;

/** Skip win-back when a failed payment of this customer resolved within this many days before canceling. */
export const WINBACK_RECENT_RESOLVED_DAYS = 7;

/** Win-back step 1 delay for customers Intelligence has not flagged `winback_priority`. */
export const WINBACK_UNFLAGGED_STEP1_HOURS = 4;

/** The `customer_context.health_factors.recommended_action` value the win-back gate compares against. */
export const WINBACK_PRIORITY_ACTION = "winback_priority";

// 5 attempts over ~17.25 hours.
export const SEND_MAX_ATTEMPTS = 5;
/** Backoff minutes indexed by (attempt_count - 1); the last repeats if the table is short. Sums to 1035. */
export const SEND_RETRY_BACKOFF_MINUTES = [15, 60, 240, 720] as const;

/** Ticks a retry step waits for a usable connected-account token before going terminal on `retry_no_connection`; a missing token is usually transient. */
export const RETRY_TOKEN_MAX_ATTEMPTS = 3;

// "unknown" is the fail-closed default: no auto-retry.
export const DECLINE_CATEGORIES = [
  "soft",
  "network",
  "expired",
  "fraud",
  "revoked",
  "unknown",
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

/** Max age of a /p/:token card-update link; matches the longest step schedule (EMAIL_DAY30). */
export const CARD_UPDATE_TOKEN_MAX_AGE_MS = 30 * DAY_MS;
/** Per-cron DO lock lease: outlives the tick period and Cloudflare's 15-minute invocation cap, so an expired lease means a dead holder. */
export const CRON_LOCK_LEASE_MS = 16 * 60 * 1000;
/** How long /admin/operations waits for one lock peek before "Could not read". */
export const CRON_LOCK_PEEK_TIMEOUT_MS = 2000;
/** Expiring-card alert lookahead in days; already-expired cards belong to dunning. */
export const EXPIRING_CARD_DAYS_AHEAD = 30;
/** The Settings > Email switch for that alert; the docs name it the same way. */
export const EXPIRING_CARD_TOGGLE_LABEL = `Email customers ${EXPIRING_CARD_DAYS_AHEAD} days before their card expires`;

/** Cron schedules (UTC). MUST match wrangler.jsonc triggers.crons exactly. */
export const CRON_SCHEDULE_DAILY = "0 3 * * *"; // 03:00 UTC, retention sweeps
export const CRON_SCHEDULE_MONTHLY = "0 4 1 * *"; // 04:00 UTC on the 1st, billing run
// Monday 08:00 UTC. MON, not 1: Cloudflare numbers weekdays 1 = Sunday.
export const CRON_SCHEDULE_WEEKLY = "0 8 * * MON";
/** Monthly audit: an hour after billing. A new cron expression also goes in wrangler.jsonc triggers and alerts.server.ts's SCHEDULE_PERIOD_MS. */
export const CRON_SCHEDULE_MONTHLY_AUDIT = "0 9 1 * *";
/** Expiring-card alert: daily 09:00 UTC. Same sites as the audit's, plus CADENCE_LABEL. */
export const CRON_SCHEDULE_EXPIRING_CARDS = "0 9 * * *";
/** Recovery tick: sweeps due recovery_steps every 5 minutes; also bounds how long the brake takes to stop the next run. */
export const CRON_SCHEDULE_RECOVERY_TICK = "*/5 * * * *";
/** Scheduled blog publishing (site-api's runSchedules), every minute. */
export const CRON_SCHEDULE_BLOG = "* * * * *";
/** The ticker is one Durable Object, addressed by this name. */
export const CRON_TICKER_INSTANCE_NAME = "five-minute-ticker";
/** Max due steps per tick. A step spends ~4-5 subrequests and Workers allow ~1000. Also the limit for queryExhaustedSequences. */
export const RECOVERY_TICK_LIMIT = 100;

/** Above this many payments, a bulk MONEY submission requires a confirmation naming the count and action. */
export const BULK_ACTION_CONFIRM_THRESHOLD = 25;

/** Hard ceiling per bulk submission: refused whole, never trimmed (that would mutate a set the merchant never chose). */
export const BULK_ACTION_MAX_PER_SUBMISSION = 100;

/** Payments a bulk fan-out processes at once; the money-write DO serializes commits anyway. */
export const BULK_ACTION_CONCURRENCY = 5;
/** The recovery tick's cron name; here because the registry imports the tick. */
export const RECOVERY_TICK_CRON_NAME = "recovery-tick";
/** Retention windows: older raw rows are swept; ai_calls aggregates monthly first. */
export const RETENTION_ENGAGEMENT_DAYS = 180;
export const RETENTION_EMAIL_SENDS_DAYS = 180;
export const RETENTION_WEBHOOK_EVENTS_DAYS = 90;
export const RETENTION_HEALTH_SCORE_DAYS = 90;
export const RETENTION_CRON_LOG_DAYS = 90;
export const RETENTION_AI_CALLS_DAYS = 90;
/** The admin API call log; the database trigger refuses to delete a row younger than 30 days. */
export const RETENTION_ADMIN_API_CALLS_DAYS = 90;

export const RETENTION_PAGE_404_DAILY_DAYS = 90;
/** Max raw rows swept per table per tick. */
export const RETENTION_SWEEP_LIMIT = 5_000;

/** Trailing window the audit scans for failed/recovered invoices. */
export const AUDIT_LOOKBACK_DAYS = 90;
/** The audit's "Recoverable estimate" share: an assumption, not a measured rate; the results page says so. */
export const AUDIT_RECOVERY_ESTIMATE_PCT = 30;
/** Stripe's events API retains 30 days, so the Card Updater ratio uses 30 on both sides. */
export const CAU_EVENT_RETENTION_DAYS = 30;
/** Below this many expired-card declines in the window, no CAU advisory. */
export const MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY = 3;

/**
 * Bounded work per sync run: caps how many of an account's Stripe customers are
 * scanned in one tick. Within a run the SDK's async iterator auto-paginates to
 * this count; across runs there is no resumption cursor, so an account over it
 * rescans the same newest-first set, and AccountSyncResult.truncated surfaces
 * that in cron_run_log.
 */
export const INTELLIGENCE_MAX_CUSTOMERS_SCANNED = 2000;
/**
 * Bounded invoice history read per customer when reconstructing billing-terms
 * observations and payment-latency drift.
 */
export const INTELLIGENCE_MAX_INVOICES_PER_CUSTOMER = 24;
/** Bounded charge history read per customer for refund/dispute counts. */
export const INTELLIGENCE_MAX_CHARGES_PER_CUSTOMER = 100;

/**
 * A customer is "at risk" below this health score (0-100, higher is healthier).
 */
export const HEALTH_SCORE_AT_RISK_THRESHOLD = 40;

/**
 * The high-risk ceiling (health_score <= 33) that health alerts and the
 * critical customers check watch.
 */
export const CRITICAL_HEALTH_SCORE_MAX = 33;
/** How far out a logged prediction claims to look. */
export const PREDICTION_HORIZON_DAYS = 30;
/** Max at-risk customers named individually in the nightly narrative. */
export const INTELLIGENCE_NARRATIVE_TOP_N = 10;
/**
 * Reports a merchant may generate per account per hour from the Intelligence
 * dashboard; held by the RATE_LIMITER Durable Object, keyed per account
 * (report-generate.server.ts).
 */
export const INTELLIGENCE_REPORT_HOURLY_LIMIT = 5;
/**
 * The eleven alert metrics, in the picker's order. alerts.metric is
 * unconstrained text; this is the app-level enum, and computeAlertMetrics
 * (alert-run.server.ts) returns a value for each.
 */
export const ALERT_METRICS = [
  "recovery_rate_pct",
  "mrr_at_risk_cents",
  "active_sequences",
  "emails_sent_7d",
  "open_disputes_count",
  "disputes_due_48h",
  "dispute_amount_at_stake_cents",
  "high_risk_customers_count",
  "intelligence_mrr_at_risk_cents",
  "audit_leaking_cents",
  "audit_leaking_delta_cents",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
/**
 * Canonical alert direction values (alerts.direction is unconstrained text).
 */
export const ALERT_DIRECTIONS = ["above", "below"] as const;
export type AlertDirection = (typeof ALERT_DIRECTIONS)[number];

/** An access token lives one hour. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

/** A refresh token lives 30 days from its last rotation. */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;

/**
 * An authorization code lives ten minutes, the ceiling RFC 6749 section 4.1.2
 * recommends.
 */
export const OAUTH_CODE_TTL_MS = 10 * MINUTE_MS;
