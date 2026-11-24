// Centralized constants: no hardcoded fees, timings, limits or canon enum
// values in business logic. Enum value sets mirror the CHECK constraints in
// app/db/schema/ (kept in sync by hand).

/** Recovery fee: 20% of Foxhound-attributed recoveries (pay-on-lift). */
export const RECOVERY_FEE_BPS = 2000;
/** Dispute fee: 20% of won disputes... */
export const DISPUTE_FEE_BPS = 2000;
/**
 * ...capped at $500 per dispute (roughly 2x the median cost of losing one;
 * binds only above ~$2,500). USD minor units, always: a non-USD dispute's cap
 * is this converted at Stripe's rate on the resolution day (dispute-cap.ts).
 */
export const DISPUTE_FEE_CAP_CENTS = 50_000;

/**
 * The monthly billing Cron Trigger, "0 4 1 * *" in wrangler.jsonc, as the two
 * fields the derivation uses. /billing reads the day, so the page cannot drift
 * from the run; lives here so client code can read it without importing a
 * .server module.
 */
export const BILLING_RUN_DAY_OF_MONTH = 1;
export const BILLING_RUN_HOUR_UTC = 4;

/**
 * Ceiling on charge attempts per platform fee invoice; at the monthly cadence
 * the age cap below binds first.
 */
export const FEE_INVOICE_MAX_RETRY_ATTEMPTS = 4;
/**
 * Age cap for the same, and the cap that actually binds: the sweep runs at the
 * start of runMonthlyBilling, so an invoice is first retried a month after it
 * was written. That gives two or three retries (calendar-dependent), then
 * give_up (max_age_exceeded).
 */
export const FEE_INVOICE_MAX_RETRY_AGE_DAYS = 90;

/**
 * Demo accounts are excluded from all billing. Demo seeding must create ids
 * beginning with this prefix; real accounts use crypto.randomUUID ids, which
 * never do.
 */
export const DEMO_ACCOUNT_ID_PREFIX = "demo_";

const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * How long before a recovery a click can have happened and still be its cause:
 * Stripe's own recommended retry window, inside which a customer acts on a
 * dunning email. Outside it the recovery still records, as `stripe_baseline`,
 * free.
 */
export const EMAIL_ENGAGEMENT_WINDOW_DAYS = 14;
export const EMAIL_ENGAGEMENT_WINDOW_MS = EMAIL_ENGAGEMENT_WINDOW_DAYS * DAY_MS;

/** A recovery is billable only once it is at least this old (refund window absorption). */
export const RECOVERY_MATURITY_DAYS = 30;
export const RECOVERY_MATURITY_MS = RECOVERY_MATURITY_DAYS * DAY_MS;

/** The in-recovery status: a sequence is running and manual actions apply. */
export const FAILED_PAYMENT_STATUS_ACTIVE = "active";

/**
 * Terminal status for a sequence that ran every step without recovering.
 * Written only by the recovery tick's exhausted-sequence sweep;
 * invoice.payment_succeeded is the sole writer of 'recovered'.
 */
export const FAILED_PAYMENT_STATUS_UNRECOVERED = "failed_unrecovered";

/**
 * Terminal status for a sequence a merchant stopped on purpose. Distinct from
 * `failed_unrecovered` (stopped vs exhausted) so the paper trail for why
 * outreach ended survives. failed_payments.status has no CHECK constraint, so
 * this vocabulary alone enforces it.
 */
export const FAILED_PAYMENT_STATUS_CANCELLED = "cancelled";

/**
 * Stripe still owns this payment: it has failed at least once and Stripe's
 * Smart Retries are scheduled, so Foxhound records the payment and plans
 * nothing. The row exists from the first failure because the involuntary-churn
 * guard keys on a failed_payments row. No CHECK constraint, as above.
 */
export const FAILED_PAYMENT_STATUS_STRIPE_RETRYING = "stripe_retrying";

/**
 * The statuses of a LIVE failed payment (unpaid invoice, not terminal); they
 * differ only in whose retry clock is running. One constant because
 * listActiveFailedPaymentIds (churn guard) and findActiveFailedPayment (intake
 * dedupe) must widen together.
 */
export const LIVE_FAILED_PAYMENT_STATUSES = [
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
] as const;

/**
 * The statuses a late invoice.payment_succeeded may still recover FROM.
 *
 * 'failed_unrecovered' and 'cancelled' are included because a customer who pays
 * after the sequence exhausted, or after a merchant's "Stop recovery" (Foxhound
 * workflow state, not Stripe state), has genuinely paid, and the status must
 * tell the truth. 'stripe_retrying' is included because Stripe's own retry
 * succeeding is the common outcome for a parked payment; without it nothing
 * finds the row.
 */
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
  /**
   * A merchant asserted this payment came back. Never in
   * BILLABLE_ATTRIBUTION_KINDS: a merchant's own click is not evidence Foxhound
   * caused the payment.
   */
  "manual",
] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/**
 * The merchant-asserted attribution kind (also a recovery_method value; named
 * so the two never drift). Never billable.
 */
export const MANUAL_ATTRIBUTION_KIND = "manual";

/**
 * Attribution kinds that make a recovery billable (everything except the free
 * baseline).
 */
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
  // An inquiry (a warning_* dispute) Stripe closed as warning_closed: over,
  // with no ruling and nothing billable.
  | "inquiry_closed";

// Dispute evidence upload limits; the page's limits line is built from these,
// never typed.
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
/**
 * Unauthenticated home-page email sample generator: copy generation, so the
 * cheap model.
 */
export const MODEL_MARKETING_EMAIL_SAMPLE = "claude-haiku-5-5";
/**
 * The audit's three-sentence summary. Its own constant so a later retier knows
 * which Haiku caller it meant.
 */
export const MODEL_AUDIT_SUMMARY = "claude-haiku-5-5";
/** Token budget for the summary (three sentences). */
export const AUDIT_SUMMARY_MAX_TOKENS = 300;

// Rebuild ordering is SILENT-FIRST (PRICING.md): for retryable declines a silent Foxhound retry precedes
// the first customer-facing email, so we never dun a payment we could have
// quietly recovered. Every dunning email carries the hosted card-update link
// (/p/:token), so the card updater is a passive channel on each one.
export const STEP_TIMING_RETRY_EARLY_HOURS = 4;
export const STEP_TIMING_RETRY_4HR_HOURS = 4;
// Day 1 and day 3 email offsets.
export const STEP_TIMING_EMAIL_DAY1_HOURS = 1;
// SOFT: the silent retry (4 hours) precedes the first email, which goes 1 hour
// after it, at 5 hours.
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
// Revoked-authorization hold: a single email offering a cancel-or-update
// choice, sent soon after detection (the customer explicitly revoked, so we ask
// once rather than dun). The ONLY step for `revoked`.
export const STEP_TIMING_REVOKED_EMAIL_HOURS = 2;

// Schedule: 1h, 96h, 336h; the window is 14 days (step 3).
export const WINBACK_STEP1_HOURS = 1;
export const WINBACK_STEP2_HOURS = 96;
export const WINBACK_STEP3_HOURS = 336;

/**
 * Skip starting a win-back sequence when this customer had a failed payment
 * resolved (canceled or recovered) within this many days before canceling: it
 * keeps Foxhound from chasing a customer it has just chased.
 */
export const WINBACK_RECENT_RESOLVED_DAYS = 7;

/**
 * Win-back step 1 delay for a customer Intelligence has NOT flagged
 * `winback_priority`, when Intelligence is active on the account. It delays the
 * unflagged rather than accelerating the flagged.
 */
export const WINBACK_UNFLAGGED_STEP1_HOURS = 4;

/**
 * The `customer_context.health_factors.recommended_action` value the win-back
 * gate compares against. Nothing produces it yet; the constant keeps the
 * comparison from using a literal at the call site.
 */
export const WINBACK_PRIORITY_ACTION = "winback_priority";

// 5 attempts over ~17.25 hours. The table carries one entry per non-terminal
// attempt, so the clamp in afterTransientFailureWith is only a safety net for a
// future change to SEND_MAX_ATTEMPTS. test/recovery-step-state.test.ts pins the
// span by walking the real state machine.
export const SEND_MAX_ATTEMPTS = 5;
/**
 * Backoff minutes indexed by (attempt_count - 1); the last value repeats if the
 * table is ever shorter than SEND_MAX_ATTEMPTS - 1. Sums to 1035 minutes.
 */
export const SEND_RETRY_BACKOFF_MINUTES = [15, 60, 240, 720] as const;

/**
 * How many ticks a retry step waits for a usable connected-account token before
 * it goes terminal on `retry_no_connection`. A missing token is usually
 * transient (mid-reconnect, rotated), and the silent retry is the first step
 * for soft and network declines, so one tick must not forfeit it.
 */
export const RETRY_TOKEN_MAX_ATTEMPTS = 3;

// "unknown" is the fail-closed default for any code not in an explicit set
// below: no auto-retry. "revoked" is the customer explicitly revoking
// authorization: one cancel-or-update email, then a hold.
export const DECLINE_CATEGORIES = [
  "soft",
  "network",
  "expired",
  "fraud",
  "revoked",
  "unknown",
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

/** Authenticated send domain (warmed independently of Worker routing). */
const EMAIL_SEND_DOMAIN = "send.foxhoundapp.com";
/**
 * Envelope From address for merchant dunning copy (merchant display name is
 * prefixed per send).
 */
export const EMAIL_FROM_ADDRESS = `recovery@${EMAIL_SEND_DOMAIN}`;
/**
 * Authenticated domain for transactional platform mail (signup verification,
 * password reset), kept apart from EMAIL_SEND_DOMAIN so auth mail's reputation
 * never mixes with bulk dunning mail's. Never use for merchant-customer sends.
 */
const EMAIL_AUTH_DOMAIN = "auth.foxhoundapp.com";
/**
 * Envelope From address for transactional auth mail only
 * (sendTransactionalEmail); never EMAIL_FROM_ADDRESS.
 */
export const EMAIL_AUTH_SENDER_ADDRESS = `noreply@${EMAIL_AUTH_DOMAIN}`;
/**
 * Public utility path bases for CAN-SPAM one-click unsubscribe and the hosted
 * card-update page.
 */
export const UNSUBSCRIBE_PATH = "/u";
export const CARD_UPDATE_PATH = "/p";
/** Engagement tracking path bases (first-party open pixel + click redirect). */
export const ENGAGEMENT_OPEN_PATH = "/e/o";
export const ENGAGEMENT_CLICK_PATH = "/e/c";
/**
 * The honeypot link's route; shaped like its siblings so it is
 * indistinguishable in the markup.
 */
export const ENGAGEMENT_HONEYPOT_PATH = "/e/h";

/**
 * A click landing sooner than this after the email was sent is `too_fast`.
 * Enterprise link scanners (SafeLinks, Proofpoint, Mimecast) present a full
 * browser user agent and fetch on delivery, seconds after the send, while a
 * person has to receive and open the mail; `clicked_at - executed_at` is the
 * one stored signal that separates them.
 */
export const CLICK_SUSPECT_MIN_SECONDS = 60;
export const CLICK_SUSPECT_MIN_MS = CLICK_SUSPECT_MIN_SECONDS * 1000;

/**
 * Why a click is not trusted. Stored on recovery_steps.click_suspect_reason.
 */
export const CLICK_SUSPECT_TOO_FAST = "too_fast";
export const CLICK_SUSPECT_HONEYPOT = "honeypot";
/**
 * Queue consumer retry ceiling before dead-letter (mirrors the wrangler
 * consumer config).
 */
export const EMAIL_QUEUE_MAX_RETRIES = 3;
/** Queue names. */
export const EMAIL_QUEUE_NAME = "foxhound-email";
/** The dead-letter queue for EMAIL_QUEUE_NAME (the consumer's `dead_letter_queue` in wrangler.jsonc). */
export const EMAIL_DLQ_QUEUE_NAME = "foxhound-email-dlq";
export const EMAIL_EVENTS_QUEUE_NAME = "foxhound-email-events";
/**
 * The monthly audit queue: the cron sends one message per opted-in account, so
 * each account's Stripe pages are spent inside its own invocation's subrequest
 * budget.
 */
export const AUDIT_QUEUE_NAME = "foxhound-audit";
/**
 * Mirrors max_retries on the foxhound-audit consumer in wrangler.jsonc; the
 * delivery whose attempts exceed this is the last one and raises the alert.
 */
export const AUDIT_QUEUE_MAX_RETRIES = 3;
/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
export const AUDIT_QUEUE_SEND_BATCH_MAX = 100;

/**
 * Max age of a /p/:token card-update link before it is treated as expired
 * (mirrors the longest recovery step schedule, EMAIL_DAY30, so a link stays
 * valid for the full life of the sequence that carries it).
 */
export const CARD_UPDATE_TOKEN_MAX_AGE_MS = 30 * DAY_MS;
/**
 * Max time a single run may hold a per-cron DO lock before the lease lapses.
 * Sixteen minutes because the lease must outlive both the tick period (five
 * minutes, so a slow-but-alive run does not hand its lock to the next) and a
 * run's maximum life (Cloudflare caps a Cron Trigger invocation at 15 minutes),
 * so an expired lease means the holder is dead, not slow.
 */
export const CRON_LOCK_LEASE_MS = 16 * 60 * 1000;
/**
 * How long /admin/operations waits for one cron lock's read-only peek before
 * showing "Could not read", so one hung Durable Object cannot stall the loader.
 */
export const CRON_LOCK_PEEK_TIMEOUT_MS = 2000;
/**
 * How far ahead the expiring-card alert looks, in days. A card expiring further
 * out is too early to warn about, and one already expired is not warned about:
 * dunning owns that failure.
 */
export const EXPIRING_CARD_DAYS_AHEAD = 30;

/** Cron schedules (UTC). MUST match wrangler.jsonc triggers.crons exactly. */
export const CRON_SCHEDULE_DAILY = "0 3 * * *"; // 03:00 UTC, retention sweeps
export const CRON_SCHEDULE_MONTHLY = "0 4 1 * *"; // 04:00 UTC on the 1st, billing run
// Monday 08:00 UTC. MON, not 1: Cloudflare numbers weekdays 1 = Sunday to 7 =
// Saturday.
export const CRON_SCHEDULE_WEEKLY = "0 8 * * MON";
/**
 * The merged monthly audit: 09:00 UTC on the 1st, an hour after
 * billing-monthly, so the per-account Stripe walk plus AI call does not stack
 * on the billing run. A new cron expression has three sites: this constant, the
 * wrangler.jsonc triggers array and alerts.server.ts's SCHEDULE_PERIOD_MS
 * (without which cron-health reports an unknown-schedule blind spot).
 */
export const CRON_SCHEDULE_MONTHLY_AUDIT = "0 9 1 * *";
/**
 * The expiring-card alert: 09:00 UTC daily, so the customer-facing warning
 * lands in US daytime. Same three sites as the audit's, plus alerts.server.ts's
 * CADENCE_LABEL.
 */
export const CRON_SCHEDULE_EXPIRING_CARDS = "0 9 * * *";
/**
 * Recovery tick: sweeps due recovery_steps every 5 minutes. The cadence bounds
 * how long a newly due step waits and how long the emergency brake takes to
 * stop the NEXT run (the in-run guard stops the current one; see
 * runRecoveryTick).
 */
export const CRON_SCHEDULE_RECOVERY_TICK = "*/5 * * * *";
/**
 * Scheduled blog publishing: every minute, so a post Carrel scheduled goes live
 * within a minute. Runs site-api's runSchedules.
 */
export const CRON_SCHEDULE_BLOG = "* * * * *";
/**
 * The five-minute ticker's alarm period (workers/cron-ticker.ts): the same as
 * CRON_SCHEDULE_RECOVERY_TICK, because the ticker runs that schedule's jobs
 * when Cloudflare stops firing the trigger.
 */
export const CRON_TICKER_INTERVAL_MS = 5 * MINUTE_MS;
/** The ticker is one Durable Object, addressed by this name. */
export const CRON_TICKER_INSTANCE_NAME = "five-minute-ticker";
/**
 * Max due steps a single recovery tick processes, so one run stays bounded and
 * a backlog drains over successive ticks (mirrors RETENTION_SWEEP_LIMIT). A
 * step spends ~4-5 subrequests (guard read, Stripe charge or AI call, email
 * send, step-state write), and Workers allow ~1000 per invocation, so 100 steps
 * plus the selection query, exhausted sweep and cron_run_log write fit. Also the limit
 * flipExhaustedSequences passes to queryExhaustedSequences; split the constant if the two bounds
 * ever need to differ.
 */
export const RECOVERY_TICK_LIMIT = 100;

/**
 * Above this many payments, a bulk MONEY submission requires a confirmation
 * naming the exact count and the action. Below it, the click stands on its own.
 */
export const BULK_ACTION_CONFIRM_THRESHOLD = 25;

/**
 * Hard ceiling per bulk submission. Over this the submission is REFUSED whole
 * and its count reported; it is never trimmed, which would mutate a set the
 * merchant never chose. Equals RECOVERY_TICK_LIMIT on purpose (same subrequest
 * envelope) but stays a separate constant: they answer different questions.
 */
export const BULK_ACTION_MAX_PER_SUBMISSION = 100;

/**
 * How many payments a bulk fan-out processes at once. Small because the
 * per-account money-write DO already serializes the commits, so a higher number
 * would only widen the read phase and burst.
 */
export const BULK_ACTION_CONCURRENCY = 5;
/**
 * The recovery tick's registered cron name. Here rather than in the cron
 * registry because the registry imports the tick, and the tick re-reads its own
 * enabled flag mid-run.
 */
export const RECOVERY_TICK_CRON_NAME = "recovery-tick";
/**
 * Retention windows: raw rows older than the window are swept; ai_calls
 * aggregates to monthly before delete.
 */
export const RETENTION_ENGAGEMENT_DAYS = 180;
export const RETENTION_EMAIL_SENDS_DAYS = 180;
export const RETENTION_WEBHOOK_EVENTS_DAYS = 90;
export const RETENTION_HEALTH_SCORE_DAYS = 90;
export const RETENTION_CRON_LOG_DAYS = 90;
export const RETENTION_AI_CALLS_DAYS = 90;
/**
 * The 404 counts: 90 days, the family default, which the admin report's 30-day
 * view sits well inside.
 */
export const RETENTION_PAGE_404_DAILY_DAYS = 90;
/**
 * Max raw rows a single retention tick sweeps per table; a large backlog drains
 * over successive ticks.
 */
export const RETENTION_SWEEP_LIMIT = 5_000;

/** Trailing window the audit scans for failed/recovered invoices. */
export const AUDIT_LOOKBACK_DAYS = 90;
/**
 * The audit's "Recoverable estimate": this share of the failed invoices. It is
 * an assumption, not a measured rate, and the results page says so beside the
 * figure; no published range is quoted because none was found with a page and a
 * date to cite. Replace with a measured rate once there is one.
 */
export const AUDIT_RECOVERY_ESTIMATE_PCT = 30;
/**
 * Stripe's events API retains 30 days regardless of the audit's lookback, so
 * the Card Updater signal is measured over 30 days on both sides of its ratio.
 */
export const CAU_EVENT_RETENTION_DAYS = 30;
/**
 * Below this many expired-card declines in the CAU window, no advisory is
 * raised.
 */
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

/**
 * Pinned Stripe API version (the installed `stripe` package's default), so
 * behavior does not depend on the account's dashboard default.
 */
export const STRIPE_API_VERSION = "2026-11-18.endive";
/**
 * The public-preview channel of the same release, for preview-only endpoints
 * such as FX Quotes, which Stripe serves only on a `.preview` version.
 */
export const STRIPE_PREVIEW_API_VERSION = STRIPE_API_VERSION.replace(/\.[a-z]+$/, ".preview");
/** Stripe Connect OAuth authorize endpoint. */
export const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/**
 * Connect OAuth scope at merchant onboarding (/connect): read_write. An audit
 * prospect who converts re-authorizes here.
 */
export const STRIPE_CONNECT_SCOPE = "read_write";
export const STRIPE_AUDIT_SCOPE = "read_write";
/** CSRF state cookie name for the Connect OAuth flow. */
export const STRIPE_OAUTH_STATE_COOKIE = "__Host-stripe_oauth_state";
/**
 * CSRF state cookie name for the AUDIT OAuth flow: a separate name from
 * Connect's because both flows can be in flight in one browser, and a shared
 * one would overwrite the other's state (`invalid_state`).
 */
export const AUDIT_OAUTH_STATE_COOKIE = "__Host-audit_oauth_state";
/** Connect OAuth state cookie lifetime: 10 minutes. */
export const STRIPE_OAUTH_STATE_TTL_SECONDS = 600;
/**
 * The anonymous audit's access-token cookie: HttpOnly, Secure, SameSite=Lax,
 * five minutes, scoped to /audit. It carries the whole token (stored in no
 * table); the Stripe grant is revoked when this window ends unless a Foxhound
 * account holds that Stripe account live.
 */
// __Secure-, not __Host-: __Host- requires Path=/, and Path=/audit is what
// keeps the token off every other request.
export const AUDIT_TOKEN_COOKIE = "__Secure-audit_access_token";
/**
 * Audit access-token cookie lifetime: 5 minutes. Also the delay before Foxhound
 * revokes the audit's Stripe grant.
 */
export const AUDIT_TOKEN_TTL_SECONDS = 300;
/**
 * The audit OAuth pair's IP rate limit: 10 per hour, applied to the start and
 * the callback.
 */
export const RATE_LIMIT_AUDIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;
/** The team invite's IP rate limit: 5 per hour on `invite:{ip}`. */
export const RATE_LIMIT_INVITE = { max: 5, windowMs: 60 * 60 * 1000 } as const;

/**
 * The unsubscribe page's IP rate limit: 10 requests per 60 seconds per IP, on
 * its own bucket.
 */
export const RATE_LIMIT_UNSUBSCRIBE = { max: 10, windowMs: 60 * 1000 } as const;

/**
 * The admin API's authenticated bucket, keyed on the api_keys row id. 120 per
 * minute: an agent fans out several tool calls per turn and a read-only surface
 * has no write to serialize, yet a runaway loop is capped within a minute.
 * Keyed on the key, not the IP, because the caller is the credential.
 */
export const RATE_LIMIT_MCP = { max: 120, windowMs: 60 * 1000 } as const;
/**
 * The merchant MCP endpoint's unauthenticated bucket, keyed on cf-connecting-ip
 * and spent only when authentication FAILS: 20 per minute, matching the
 * `public` bucket. Not spent on successful requests, which would break a team
 * behind one NAT for no gain (each agent is bounded by its own key bucket).
 */
export const RATE_LIMIT_MCP_ANON = { max: 20, windowMs: 60 * 1000 } as const;

/** An access token lives one hour. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

/** A refresh token lives 30 days from its last rotation. */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;

/**
 * An authorization code lives ten minutes, the ceiling RFC 6749 section 4.1.2
 * recommends.
 */
export const OAUTH_CODE_TTL_MS = 10 * MINUTE_MS;

/** OAuth limits: approve is per signed-in user, token and revoke per IP. */
export const RATE_LIMIT_OAUTH_APPROVE = { max: 20, windowMs: 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_TOKEN = { max: 30, windowMs: 60 * 1000 } as const;
/**
 * Registration: site-runtime's registrationLimited numbers, the limit every
 * family MCP door runs: five an hour from one address (every registration),
 * thirty a day from everyone (allowlisted only).
 */
export const RATE_LIMIT_OAUTH_REGISTER = { max: 5, windowMs: 60 * 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REGISTER_DAILY = { max: 30, windowMs: 24 * 60 * 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REVOKE = { max: 30, windowMs: 60 * 1000 } as const;
