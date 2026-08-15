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

// ---- Fee-invoice collection retry (app/lib/billing/fee-retry.ts) ----
/** Ceiling on charge attempts per platform fee invoice. Legacy's value, carried
 *  over unchanged, but read the age cap below before assuming it is what stops a
 *  retry loop: at the monthly cadence this ceiling is never reached. */
export const FEE_INVOICE_MAX_RETRY_ATTEMPTS = 4;
/**
 * Age cap for the same, and THE CAP THAT ACTUALLY BINDS IN PRODUCTION. Rescaled
 * from legacy's 14 days, which was tuned to an HOURLY cron: at Foxhound's
 * monthly cadence a 14-day cap would fire before the first retry ever ran,
 * making the whole retry path unreachable.
 *
 * COUNT THE RUNS, because the numbers do not say what they look like. The sweep
 * runs at the START of runMonthlyBilling, so the earliest sweep that can see an
 * invoice is a full month AFTER the run that wrote it:
 *
 *   Aug 1  invoice created (created_at = this run)
 *   Sep 1  age 31, attempt 1 -> pay
 *   Oct 1  age 61, attempt 2 -> pay
 *   Nov 1  age 92 > 90       -> give_up (max_age_exceeded)
 *
 * So TWO or THREE retries, never four: the exact count is calendar-dependent
 * (three short months fit inside 90 days, three long ones do not), and it is
 * always the AGE cap that stops the loop. Do not restate it as a single number;
 * two earlier attempts to do that were each correct only for the month they were
 * derived from. Stopping after about three months is ACCEPTED as intended
 * (Dustin, 2026-07-26). The attempt ceiling above only binds if runs are closer
 * together than monthly. test/billing-fee-retry.test.ts walks the real cron
 * cadence across every start month and pins the property rather than a count.
 */
export const FEE_INVOICE_MAX_RETRY_AGE_DAYS = 90;

// ---- Subscription entitlement (account_subscriptions) ----
/** account_subscriptions.product for the paid Intelligence tier. The entitlement
 *  gate (isIntelligenceEntitled) and the admin grant path both key on this, so it
 *  lives here rather than as a literal in either, and they cannot drift. */
export const INTELLIGENCE_PRODUCT = "intelligence";
/** account_subscriptions.status: an active row is what the entitlement gate reads;
 *  a granted row is deactivated to canceled on admin revoke. */
export const SUBSCRIPTION_STATUS_ACTIVE = "active";
export const SUBSCRIPTION_STATUS_CANCELED = "canceled";

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

// ---- failed_payments lifecycle ----
/** The in-recovery status: a sequence is running and manual actions apply.
 *  Legacy gates its whole action row on this one value (PaymentDetailClient.tsx
 *  at blob 7f54aa45: `const isActive = payment.status === 'active'`), and three
 *  of its four action handlers re-check it server-side before mutating. */
export const FAILED_PAYMENT_STATUS_ACTIVE = "active";

/** Terminal status for a sequence that ran every step without recovering.
 *  Written ONLY by the recovery tick's exhausted-sequence sweep; the
 *  invoice.payment_succeeded webhook remains the sole writer of 'recovered'. */
export const FAILED_PAYMENT_STATUS_UNRECOVERED = "failed_unrecovered";

/**
 * Terminal status for a sequence a MERCHANT stopped on purpose (S7's "Stop
 * recovery"), ruling 262 decision two. Deliberately DISTINCT from
 * `failed_unrecovered`: operator-terminated and exhausted mean different things,
 * the same reason Stripe keeps `void` and `uncollectible` apart, and folding
 * them would destroy the paper trail for why outreach ended.
 *
 * No schema migration adds this. `failed_payments.status` is `text NOT NULL`
 * with NO CHECK constraint (verified across all 13 committed migrations), so the
 * column already accepts it and the value is enforced by this vocabulary alone.
 * Legacy writes the same string, from its cancel route and its Stripe webhook.
 */
export const FAILED_PAYMENT_STATUS_CANCELLED = "cancelled";

/**
 * The statuses a late invoice.payment_succeeded may still recover FROM.
 *
 * 'active' is the normal case. 'failed_unrecovered' matters because a customer
 * who pays on day 45, after a 30-day sequence exhausted, has genuinely been
 * recovered: the sequence ending is Foxhound giving up on outreach, not the
 * payment becoming uncollectible. Before the exhausted-sequence flip existed
 * nothing ever left 'active', so this list had no reason to exist; with the flip
 * in place, a single-status check would silently drop those recoveries on the
 * floor (no recovered_payments row, no attribution, no fee).
 *
 * 'cancelled' JOINED THE LIST 2026-08-14 under ruling 284 decision one, which is
 * the whole of that session's build. A merchant's "Stop recovery" is FOXHOUND
 * WORKFLOW STATE, not Stripe state: Stripe does not rescind the invoice, and a
 * past-due invoice can still be paid after the merchant's workflow moved on.
 * When it is, the money is a FACT, so the recovery is recorded and the status
 * flips to 'recovered' because the status must tell the truth. Billing is not
 * affected by this list at all: attribution resolves by the NORMAL precedence
 * from the steps that actually ran, so a pure post-stop payment has no Foxhound
 * signal, records `stripe_baseline`, and bills NOTHING, while a click that
 * provably preceded the stop keeps its kind and bills. The stop click therefore
 * neither launders a Foxhound recovery free nor bills one Foxhound did not cause.
 *
 * DIVERGENCE FROM LEGACY, ratified onto PRIME DIRECTIVE item 3 under 284:
 * legacy's handlePaymentSucceeded selects `.eq('status','active')` alone, so a
 * cancelled payment is never found and legacy records nothing at all, losing the
 * row, the moat entry and the truthful status. Measured at source, not inferred.
 *
 * Deliberately NOT used for intake dedupe: a NEW failure on an invoice whose
 * prior sequence exhausted must spawn a fresh sequence, so that path still keys
 * on 'active' alone.
 *
 * TWO call sites and they must stay symmetric, which is why this is one constant
 * and not two literals: findRecoverableFailedPayment (webhooks/process.ts) finds
 * the row, and buildRecoverBatch's status flip (webhooks/batches.ts) accepts it.
 * Both would have to be widened for the recovery to land, and both are widened
 * here at once.
 */
export const RECOVERABLE_FAILED_PAYMENT_STATUSES = [
  "active",
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  FAILED_PAYMENT_STATUS_CANCELLED,
] as const;

// ---- Canon enum value sets (mirror schema CHECK constraints) ----
export const ATTRIBUTION_KINDS = [
  "foxhound_retry",
  "email_engaged",
  "card_update",
  "stripe_baseline",
  /**
   * A MERCHANT asserted this payment came back, through S7's "Mark as recovered".
   * Its own kind per ruling 262 decision one, and NEVER in
   * BILLABLE_ATTRIBUTION_KINDS below: the moat keeps the row because money that
   * returned is a fact worth recording, and billing ignores it because a
   * merchant's own click is not evidence that Foxhound caused the payment.
   * PRICING.md rev 3 controls, and legacy is the diverging side of this one
   * question: its billable set includes recovery_method 'manual'.
   */
  "manual",
] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

/** The merchant-asserted attribution kind. Named so no call site spells the
 *  string, since it is simultaneously an attribution kind and a recovery_method
 *  value and the two must not drift apart. NEVER billable (262 decision one). */
export const MANUAL_ATTRIBUTION_KIND = "manual";

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
/** Intelligence nightly AI analyst narrative + per-customer assessments. */
export const MODEL_INTELLIGENCE_NARRATIVE = "claude-sonnet-5";
/** Cheap quality/scoring gate on generated copy. */
export const MODEL_EMAIL_QUALITY = "claude-haiku-4-5-20251001";
/** Unauthenticated home-page email sample generator: copy generation, not
 *  money-path reasoning, so the cheap model is correct here too. */
export const MODEL_MARKETING_EMAIL_SAMPLE = "claude-haiku-4-5-20251001";

/**
 * Every model id the app may call. The ai_calls cost map (app/lib/ai/cost.ts)
 * MUST cover each (closes legacy R-49 drift: a model with no cost entry throws).
 * Cost lookup normalizes a trailing -YYYYMMDD date suffix to the canonical base
 * id, so both `claude-haiku-4-5` and `claude-haiku-4-5-20251001` resolve.
 */
export const AI_MODEL_IDS = [
  MODEL_RECOVERY_EMAIL,
  MODEL_INTELLIGENCE_NARRATIVE,
  MODEL_EMAIL_QUALITY,
  MODEL_MARKETING_EMAIL_SAMPLE,
] as const;

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
// LEGACY'S SCHEDULE EXACTLY: 1h, 96h, 336h.
//
// The window is 14 days (step 3), restored from the rebuild's 7 by parity CHUNKS
// item 17. The compression to 7 was never justified: a Pass 4 git-blame check
// found all three values authored once, at file creation, inside a commit about
// decline classification, with no comment and no decision record. Every other
// intentional value change in this file carries its reasoning, so the absence was
// the finding.
//
// THE INTERIOR STEPS ARE ALIGNED 2026-08-14 by ruling 291, 24h to 1h and 72h to
// 96h. This comment previously read "the interior steps (24h, 72h) stay as the
// rebuild set them; only the outer bound reverted, because that is the span the
// ruling names", and Session 6 correctly STOPPED on it as a recorded rationale.
// 291 answered the escalation: that sentence records only which span the earlier
// restoration REACHED, and the blame finding above is proof the interiors were
// never RATIFIED rather than proof they were. Provenance is not ratification, and
// under the PRIME DIRECTIVE an unratified user-facing divergence is a defect.
// The counter-argument is on record and declined: a 24h first touch reads gentler
// than legacy's 1h, but that is taste against spec, and the silent-first
// reasoning that justifies Foxhound's RECOVERY reordering does not apply to a
// cancellation, where there is no payment to quietly retry.
//
// CITATION, per 291: "item 17" here is CHUNKS item 17, the constants trio, NOT
// volume ruling 17, which is a different subject. A numbered citation names its
// numbering.
export const WINBACK_STEP1_HOURS = 1;
export const WINBACK_STEP2_HOURS = 96;
export const WINBACK_STEP3_HOURS = 336;

/**
 * Skip starting a win-back sequence when this customer had a failed payment
 * RESOLVED (cancelled or recovered) within this many days before cancelling.
 * Ported verbatim from legacy's WINBACK_RECENT_RESOLVED_DAYS = 7 with legacy's
 * own reason: it keeps Foxhound from chasing a customer it has just chased.
 * Added 2026-08-14 with the win-back creation path (290); it had no Foxhound
 * counterpart because nothing created a sequence to gate. Moved below the step
 * trio 2026-08-14 so the three timing values read together.
 */
export const WINBACK_RECENT_RESOLVED_DAYS = 7;

/**
 * Win-back step 1 delay for a customer Intelligence has NOT flagged
 * `winback_priority`, when Intelligence is active on the account (291, ported
 * verbatim from legacy). Legacy's literal: `step1OffsetHours = 4`, measured
 * against its 1h default, so this DELAYS the unflagged rather than accelerating
 * the flagged. Only meaningful because WINBACK_STEP1_HOURS is now legacy's 1.
 */
export const WINBACK_UNFLAGGED_STEP1_HOURS = 4;

/**
 * The `customer_context.health_factors.recommended_action` value legacy compares
 * against for the win-back gate (291). Ported verbatim. It has NO producer in
 * Foxhound today and does not appear in the demo seed's vocabulary either, which
 * is the bound M9 records; the constant exists so the comparison is legacy's
 * string rather than a literal invented at the call site.
 */
export const WINBACK_PRIORITY_ACTION = "winback_priority";

// ---- Send-attempt retry (transient send failures; SCHEMA.md recovery_steps state) ----
// 5 attempts over ~17.25 hours, both restored by parity CHUNKS item 17 (the
// same item as the win-back trio above; named by its numbering per 291).
//
// The count was restored first and the SPAN was left behind, which produced a
// third value (~4.6h) matching neither legacy nor the rebuild: attempts 4 and 5
// repeated a clamped 120-minute wait, so the tail was flat rather than backed
// off. The table now carries one entry per non-terminal attempt, so the clamp in
// afterTransientFailureWith is never reached in normal operation. It stays as a
// safety net for a future change to SEND_MAX_ATTEMPTS, not as load-bearing
// behaviour. test/constants-chunks-17.test.ts pins the span by walking the real
// state machine, so shortening either the table or the count fails CI.
export const SEND_MAX_ATTEMPTS = 5;
/** Backoff minutes indexed by (attempt_count - 1); the last value repeats if the
 *  table is ever shorter than SEND_MAX_ATTEMPTS - 1. Sums to 1035 minutes. */
export const SEND_RETRY_BACKOFF_MINUTES = [15, 60, 240, 720] as const;

/**
 * How many ticks a retry step waits for a usable connected-account token before
 * it goes terminal on `retry_no_connection`.
 *
 * A missing token is TRANSIENT far more often than it is permanent: the merchant
 * is mid-reconnect, or a token was rotated. Going terminal on the first tick
 * permanently forfeited the silent retry, and under silent-first ordering that
 * is the FIRST step for soft and network declines, the one most likely to
 * recover the money without ever emailing the customer. Same shape and the same
 * backoff table as a transient send failure (review MEDIUM-2).
 */
export const RETRY_TOKEN_MAX_ATTEMPTS = 3;

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
/** Authenticated domain for transactional platform mail (signup verification,
 *  password reset) - onboarded separately from EMAIL_SEND_DOMAIN so auth mail's
 *  reputation never mixes with bulk dunning mail's (TASK-foxhound-email-
 *  provisioning.md). Never use for merchant-customer sends. */
export const EMAIL_AUTH_DOMAIN = "auth.foxhoundapp.com";
/** Envelope From address for transactional auth mail only (sendTransactionalEmail).
 *  Never EMAIL_FROM_ADDRESS: a signup-verification email from "recovery@" reads
 *  wrong and would muddy the auth-vs-dunning reputation split this domain split
 *  exists for. */
export const EMAIL_AUTH_SENDER_ADDRESS = `noreply@${EMAIL_AUTH_DOMAIN}`;
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
/** Recovery tick: sweeps due recovery_steps. Every 5 minutes.
 *
 *  The original rationale (matching the 5-minute first send-retry backoff) no
 *  longer holds: SEND_RETRY_BACKOFF_MINUTES[0] is 15 since CHUNKS item 17 restored
 *  the legacy span, so the cadence is now finer than the shortest backoff rather
 *  than equal to it. The cadence still stands on its own terms. It bounds how
 *  long a newly due step waits, and it bounds how long the emergency brake takes
 *  to stop the NEXT run, which matters because the in-run guard stops the
 *  current one (see runRecoveryTick). Recorded rather than silently left stale,
 *  because a comment justifying a number by another number that has moved is how
 *  the next reader gets misled. */
export const CRON_SCHEDULE_RECOVERY_TICK = "*/5 * * * *";
/**
 * Max due steps a single recovery tick processes, so one run stays bounded and a
 * backlog drains over successive ticks (mirrors RETENTION_SWEEP_LIMIT).
 *
 * 100, down from 500, because 500 was never inside an honest subrequest budget.
 * Workers allow ~1000 subrequests per invocation, and one step spends several:
 *
 *   1  the per-step guard read (one batched round trip, recovery-tick.ts)
 *   1  the Stripe charge (retry) or the AI generation call (email)
 *   1  the EMAIL send, on email steps
 *   1-2 the step-state write, plus attribution reads on a retry
 *   ------
 *   ~4-5 per step, so 100 steps is ~400-500 plus the selection query, the
 *        exhausted sweep and one cron_run_history write.
 *
 * At 500 that arithmetic lands around 2000-2500 and the tick could not have
 * completed a full batch. The old value only ever looked safe because a full
 * batch has never occurred: the platform has one seeded demo account.
 *
 * Lowering it costs nothing in correctness. Unprocessed due steps keep a null
 * result and a null executed_at, which is exactly what stepDueCondition selects,
 * so they are re-selected by the next tick five minutes later and the backlog
 * drains. `backlog` in the run message reports when a tick hit the cap.
 *
 * SECOND CONSUMER, and it is not a step cap (review LOW-1). flipExhaustedSequences
 * passes this same constant to queryExhaustedSequences as that sweep's own limit,
 * so dropping 500 to 100 ALSO cut the exhausted-sequence flip from at most 500
 * per tick to at most 100 per tick. That was never stated when the constant
 * moved, and the arithmetic above accounts only for per-step cost.
 *
 * Sharing it is still right: both bounds exist to keep ONE invocation inside ONE
 * subrequest budget, and the flip is a single batched write however many ids it
 * carries. The consequence is a drain rate, not a correctness change. At 288
 * ticks a day a backlog of exhausted-but-still-active sequences clears five
 * times slower than before, and still clears. If the two bounds ever need to
 * differ, split the constant rather than re-tuning this one: a step cap and a
 * sweep cap answer different questions.
 *
 * Phase 8: re-derive this from MEASURED per-step subrequest cost rather than the
 * estimate above. The estimate is deliberately conservative and is not a
 * substitute for instrumenting a real run.
 */
export const RECOVERY_TICK_LIMIT = 100;

// ---- S6 bulk actions (ruling 274 decision four and five) ----
/**
 * Above this many payments, a bulk MONEY submission requires a confirmation
 * naming the exact count and the action. Below it, the click stands on its own.
 * The number is the seat's (274 decision four); no repo convention governed it
 * and none conflicts with it.
 */
export const BULK_ACTION_CONFIRM_THRESHOLD = 25;

/**
 * Hard ceiling per bulk submission. Over this the submission is REFUSED whole
 * and its own count reported; it is never trimmed to the first hundred, which
 * would mutate a set the merchant never chose (274 decision four).
 *
 * It coincides with RECOVERY_TICK_LIMIT above, and the coincidence is load
 * bearing rather than cosmetic: that constant exists to keep ONE invocation
 * inside ONE subrequest budget at roughly 4 to 5 subrequests per unit of work,
 * and a bulk fan-out of 100 dispatcher calls sits in the same envelope. The two
 * are kept SEPARATE constants because they answer different questions, exactly
 * as RECOVERY_TICK_LIMIT's own comment instructs for its second consumer.
 */
export const BULK_ACTION_MAX_PER_SUBMISSION = 100;

/**
 * How many payments a bulk fan-out processes at once. Legacy uses an UNCAPPED
 * Promise.all over the whole selection; this bounds the burst.
 *
 * NEW, not inherited: the repo carries no concurrency utility and no comparable
 * constant, measured across app/. Small because the per-account money-write DO
 * already serialises the commits, so a higher number would widen only the read
 * phase and the peak subrequest burst, buying nothing on the write path.
 */
export const BULK_ACTION_CONCURRENCY = 5;
/** The recovery tick's registered cron name. Lives here rather than in the cron
 *  registry because both the registry and the tick itself need it (the tick
 *  re-reads its own enabled flag mid-run), and the registry imports the tick, so
 *  naming it there would close an import cycle. */
export const RECOVERY_TICK_CRON_NAME = "recovery-tick";
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

// ---- Intelligence AI half (health scoring, predictions, alerts, narrative) ----
/** A customer is "at risk" below this health score (0-100, higher is
 *  healthier). Drives MRR-at-risk exposure, the narrative's top-N selection,
 *  and the /intelligence UI. */
export const HEALTH_SCORE_AT_RISK_THRESHOLD = 40;
/** How far out a logged prediction claims to look. Grading (filling
 *  realizedOutcome once this elapses) is a later backtest pass. */
export const PREDICTION_HORIZON_DAYS = 30;
/** Max at-risk customers named individually in the nightly AI narrative. */
export const INTELLIGENCE_NARRATIVE_TOP_N = 10;
/** Canonical alert metric keys the nightly evaluator understands (alerts.metric
 *  is unconstrained text in the schema; this is the app-level enum until a
 *  settings UI for creating alerts exists). */
export const ALERT_METRICS = [
  "health_score_avg",
  "mrr_at_risk_cents",
  "mrr_churn_cents",
  "mrr_contraction_cents",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
/** Canonical alert direction values (alerts.direction is unconstrained text). */
export const ALERT_DIRECTIONS = ["above", "below"] as const;
export type AlertDirection = (typeof ALERT_DIRECTIONS)[number];

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

/**
 * Statement descriptor shown on a merchant's card statement for platform
 * invoice charges (Stripe's cap is 22 characters). Settled by the
 * operating-entity ruling (recova/decisions.md, 2026-07-21): entity-independent,
 * so it does not change at Foxing LLC formation. NOT wired into
 * createPlatformInvoice (app/lib/billing/stripe-invoice.ts) yet; live charge
 * dispatch is Phase 8. The Stripe account's own dashboard-level statement
 * descriptor is a separate Phase 9 dashboard action, not code.
 */
export const STRIPE_STATEMENT_DESCRIPTOR = "FOXHOUND";
/**
 * Stripe Connect platform display name. Settled by the same 2026-07-21
 * ruling; entity-independent. There is no code-level Stripe API call this
 * feeds today, the merchant-facing platform name shown during Connect OAuth
 * is configured on the Stripe dashboard, a separate Phase 9 dashboard action.
 */
export const STRIPE_CONNECT_PLATFORM_NAME = "Foxhound";
