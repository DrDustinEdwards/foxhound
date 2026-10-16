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
 *  ~$2,500 disputed amount, the percentage governs below that).
 *
 *  USD MINOR UNITS, always, and it is not the cap a non-USD dispute is charged
 *  under (rev 5 item 2, ruling 377(7)). That one is this number converted at
 *  Stripe's rate on the resolution day; see dispute-cap.ts. Reading this as
 *  "50,000 of whatever currency" is the defect rev 5 removed. */
export const DISPUTE_FEE_CAP_CENTS = 50_000;
/** Intelligence predictive risk layer: $199/month. */
export const INTELLIGENCE_PRICE_CENTS = 19_900;

// ---- The monthly billing run ----
/** The monthly billing Cron Trigger, "0 4 1 * *" in wrangler.jsonc. Kept as the
 *  two fields the derivation actually uses so a cron change is a one-line edit
 *  here rather than arithmetic buried in a function body. The day is also what
 *  /billing says ("Invoiced on the 1st"), so the page cannot drift from the run.
 *  Moved here from app/lib/billing/preview.server.ts (J65) so the page, which
 *  is client code, can read it without importing a .server module. */
export const BILLING_RUN_DAY_OF_MONTH = 1;
export const BILLING_RUN_HOUR_UTC = 4;

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
/**
 * How long before a recovery a click can have happened and still be its cause
 * (PRICING.md rev 5 item 4, ruling 377(2)).
 *
 * `email_engaged` used to mean "any step on this payment has clicked_at set",
 * with no window and no ordering, which is legacy's rule
 * (`executedSteps.some(s => s.last_clicked_at)`). Legacy got away with it by
 * bounding the RECOVERY instead: its handlePaymentSucceeded requires
 * status='active' and its day-30 sweep flips the row, so a late payment
 * recorded nothing at all. 284 deliberately widened Foxhound so late
 * recoveries DO record; it never ruled that a months-old click caused them.
 *
 * Fourteen days is Stripe's own recommended retry window, and a customer who
 * acts on a dunning email acts inside it. Outside it the recovery still
 * records, as `stripe_baseline`, free.
 */
export const EMAIL_ENGAGEMENT_WINDOW_DAYS = 14;
export const EMAIL_ENGAGEMENT_WINDOW_MS = EMAIL_ENGAGEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
 * STRIPE STILL OWNS THIS PAYMENT. The invoice has failed at least once and
 * Stripe's own Smart Retries are still scheduled, so Foxhound has recorded the
 * payment and planned NOTHING (ruling 377(1)).
 *
 * The split exists because the docs' promise, "Foxhound starts after Stripe's
 * own Smart Retries have run and failed", was false at HEAD: intake spawned the
 * sequence on the FIRST invoice.payment_failed, so Foxhound's 4-hour retry and
 * day-1 email ran while Stripe was still trying, and a coincident click made
 * Stripe's own recovery billable.
 *
 * The row is created anyway rather than waiting, because halt 1 of session 82
 * measured what waiting costs: the involuntary-churn guard keys on a
 * failed_payments row, and an empty window would turn a card-failure
 * cancellation into a win-back. So the row exists from the first failure and
 * carries this status until Stripe gives up.
 *
 * No migration adds this value. failed_payments.status is text NOT NULL with NO
 * CHECK constraint, the same reason recorded on FAILED_PAYMENT_STATUS_CANCELLED
 * above, so the vocabulary in this file is the enforcement.
 */
export const FAILED_PAYMENT_STATUS_STRIPE_RETRYING = "stripe_retrying";

/**
 * The statuses of a failed payment that is LIVE: Foxhound has it and it has not
 * reached a terminal state. Both mean "this customer has an unpaid invoice
 * right now"; they differ only in whose retry clock is running.
 *
 * ONE constant rather than two literals because both readers must widen
 * together. listActiveFailedPaymentIds (the involuntary-churn guard, 377(1)
 * halt 1) has to see a stripe_retrying row or a cancellation during Stripe's
 * own retry window reads as voluntary churn and triggers a win-back at exactly
 * the wrong moment. findActiveFailedPayment (the per-invoice intake dedupe) has
 * to see it or the second payment_failed on the same invoice creates a SECOND
 * row instead of promoting the first.
 */
export const LIVE_FAILED_PAYMENT_STATUSES = [
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
] as const;

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
 *
 * 'stripe_retrying' JOINED THE LIST 2026-08-26 under ruling 377(1), and it is
 * an ADDITION FORCED BY THAT SPLIT rather than a re-opening of 284. Once intake
 * parks a payment while Stripe's own retries run, the overwhelmingly COMMON
 * outcome is that Stripe's retry succeeds. Without this entry that payment is
 * found by nothing: no recovered_payments row, no moat entry, and the failed
 * payment sits in 'stripe_retrying' forever while the customer is paid up.
 * Measured, not reasoned: the plant "a payment on a parked invoice still
 * records" in test/intake-split-377.test.ts fails with zero recoveries against
 * a list without it.
 *
 * It changes no billing. Attribution resolves from the steps that actually ran
 * and a parked row has none, so the recovery records `stripe_baseline` and
 * bills NOTHING, which is the correct answer: Stripe's own retry got the money.
 * That is the same argument 284 made for 'cancelled', reaching the same place.
 * FLAGGED FOR RATIFICATION: the seat's brief said not to touch this constant,
 * scoped to the click window in 377(2); this entry is 377(1)'s consequence and
 * is recorded here rather than worked around at a call site, because the whole
 * reason this is one constant is that both readers widen together.
 */
export const RECOVERABLE_FAILED_PAYMENT_STATUSES = [
  "active",
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  FAILED_PAYMENT_STATUS_CANCELLED,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
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
/** The audit's three-sentence summary. NO DIVERGENCE FROM LEGACY HERE: its
 *  `MODEL_HAIKU_PINNED` is this same dated Haiku 4.5 snapshot, byte for byte,
 *  so 353 binding 6 has nothing to rule on. Its own constant because the audit
 *  is its own subsystem and a later retier should not have to guess which of
 *  three Haiku callers it meant. */
export const MODEL_AUDIT_SUMMARY = "claude-haiku-4-5-20251001";
/** Legacy's own budget for the summary, ported as found. Three sentences. */
export const AUDIT_SUMMARY_MAX_TOKENS = 300;

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
  MODEL_AUDIT_SUMMARY,
] as const;

// ---- Recovery step timing (hours from failure detection) ----
// Rebuild ordering is SILENT-FIRST (PRICING.md): for retryable declines a silent
// Foxhound retry precedes the first customer-facing email, so we never dun a
// customer a payment we could have quietly recovered. Every dunning email also
// carries the hosted card-update link (/p/:token), so the card-updater is a
// passive channel on every email rather than a separate step.
export const STEP_TIMING_RETRY_EARLY_HOURS = 4;
export const STEP_TIMING_RETRY_4HR_HOURS = 4;
// Recova's offsets for the day 1 and day 3 emails (J85, rows E4 and E5):
// lib/constants.ts (blob a21b32b8) sets email_day1 at 1 hour, and
// lib/recovery-schedules.ts (blob 88f4e97a) writes network's retry_day2 at 24
// and email_day3 at 48 as literals in its network row. Foxhound had 24 for day 1
// and 48 and 72 for network, with no ruling recorded for any of them.
export const STEP_TIMING_EMAIL_DAY1_HOURS = 1;
// SOFT IS HELD at Foxhound's 24 hours, the one place day 1 cannot follow Recova:
// the silent retry comes before the first email (APPROVED-DIFFERENCES,
// 2026-08-01) and runs at 4 hours, so a 1 hour email would come first. How long
// after the retry the email goes is Dustin's to say; the question is in J85's
// pull request. Until then the value is unchanged.
export const STEP_TIMING_SOFT_EMAIL_DAY1_HOURS = 24;
export const STEP_TIMING_RETRY_DAY2_HOURS = 48;
export const STEP_TIMING_NETWORK_RETRY_DAY2_HOURS = 24;
export const STEP_TIMING_EMAIL_DAY3_HOURS = 72;
export const STEP_TIMING_NETWORK_EMAIL_DAY3_HOURS = 48;
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
/** The honeypot link's route (ruling 377(4) phase one). Deliberately shaped
 *  like its siblings so it is indistinguishable in the markup. */
export const ENGAGEMENT_HONEYPOT_PATH = "/e/h";

/**
 * A click landing sooner than this after the email was sent is `too_fast`
 * (ruling 377(4) phase one).
 *
 * The walk that produced 377(4) found the click guard reads four things and
 * none of them separates a scanner from a person: IP is persisted nowhere,
 * `email_clicked_count` and `time_to_open_minutes` had zero writers (the open
 * stamp writes time to open since row F9, J26, and the click stamp counts
 * clicks since row F10, J27; neither says whether a click was a person), and an enterprise link scanner (SafeLinks,
 * Proofpoint, Mimecast) presents a full browser user agent, so 369's named-bot
 * list cannot see it. The only live
 * discriminator already stored is `clicked_at - executed_at`, and nothing read
 * it.
 *
 * Sixty seconds is chosen against how the scanners behave rather than how
 * people do: they fetch on delivery, which is seconds after the send, while a
 * person has to receive the mail, notice it and open it. It is not a proof of
 * humanity and is not meant to be. It is one cheap test that a whole class of
 * false billable clicks fails.
 */
export const CLICK_SUSPECT_MIN_SECONDS = 60;
export const CLICK_SUSPECT_MIN_MS = CLICK_SUSPECT_MIN_SECONDS * 1000;

/** Why a click is not trusted. Stored on recovery_steps.click_suspect_reason. */
export const CLICK_SUSPECT_TOO_FAST = "too_fast";
export const CLICK_SUSPECT_HONEYPOT = "honeypot";
/** Queue consumer retry ceiling before dead-letter (mirrors the wrangler consumer config). */
export const EMAIL_QUEUE_MAX_RETRIES = 3;
/** Queue names (batch.queue switch in the consumer; Dustin creates queues with these names). */
export const EMAIL_QUEUE_NAME = "foxhound-email";
/** The dead-letter queue for EMAIL_QUEUE_NAME. Declared in wrangler.jsonc as the
 *  consumer's `dead_letter_queue` since the queues were provisioned, and given a
 *  CONSUMER at 313: until then it had zero consumers and a dunning email that
 *  exhausted its retries was discarded with no trace. */
export const EMAIL_DLQ_QUEUE_NAME = "foxhound-email-dlq";
export const EMAIL_EVENTS_QUEUE_NAME = "foxhound-email-events";
/** The monthly audit queue (job_97878f0d1fde). The monthly-audit cron sends one
 *  message per opted-in account and the consumer audits the one account a
 *  message names, so each account's Stripe pages are spent inside its own
 *  invocation's subrequest budget instead of one shared one. */
export const AUDIT_QUEUE_NAME = "foxhound-audit";
/** Mirrors max_retries on the foxhound-audit consumer in wrangler.jsonc. The
 *  delivery whose attempts exceed this is the last one, and raises the alert. */
export const AUDIT_QUEUE_MAX_RETRIES = 3;
/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
export const AUDIT_QUEUE_SEND_BATCH_MAX = 100;

// ---- Cron Triggers + retention (ARCHITECTURE.md: all scheduled jobs are Cron
// Triggers; retention crons live before any table they govern takes writes) ----
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Max age of a /p/:token card-update link before it is treated as expired
 *  (mirrors the longest recovery step schedule, EMAIL_DAY30, so a link stays
 *  valid for the full life of the sequence that carries it). */
export const CARD_UPDATE_TOKEN_MAX_AGE_MS = 30 * DAY_MS;
/**
 * Max time a single run may hold a per-cron DO lock before the lease lapses.
 *
 * SIXTEEN MINUTES, AND THE NUMBER IS DERIVED (376 item 14). It was five, which
 * is EXACTLY the recovery tick's period (CRON_SCHEDULE_RECOVERY_TICK, every five
 * minutes), so a tick that ran a second long had its lease expire at the instant
 * its successor fired. The lease
 * has to clear two different bars and sixteen is the smaller number that clears
 * both:
 *
 *   1. LONGER THAN THE TICK PERIOD, so a slow-but-alive run does not hand its
 *      lock to the run behind it. Five minutes cleared this by zero.
 *   2. LONGER THAN A RUN CAN POSSIBLY LIVE, so an expired lease means the holder
 *      is DEAD rather than merely slow. Cloudflare caps a Cron Trigger
 *      invocation at 15 minutes of wall time
 *      (developers.cloudflare.com/workers/platform/limits/), so 16 gives one
 *      minute past the platform's own hard kill.
 *
 * The fence and the lease are different guarantees and both are needed. The
 * fence stops a stale holder FREEING a lease it no longer owns; only a lease
 * longer than the maximum runtime stops two runs being live at once in the first
 * place.
 *
 * WHAT IT COSTS, stated rather than left implicit: a run whose isolate is killed
 * without its `finally` reaching release wedges that job for up to sixteen
 * minutes, which is three recovery ticks. cron-health's staleness alert fires at
 * two missed periods, so that outage announces itself rather than being silent.
 */
export const CRON_LOCK_LEASE_MS = 16 * 60 * 1000;
/** How long /admin/operations waits for one cron lock's read-only peek before it
 *  shows that lock as "Could not read". One hung Durable Object must not stall
 *  the page's whole loader (review of #97). */
export const CRON_LOCK_PEEK_TIMEOUT_MS = 2000;
/** Cron schedules (UTC). MUST match wrangler.jsonc triggers.crons exactly. */
/** How far ahead the expiring-card alert looks, in days. Legacy's
 *  `EXPIRING_CARD_DAYS_AHEAD = 30` (lib/constants.ts:39), ported as the number
 *  it is. The guard it feeds is a BAND: a card expiring further out than this
 *  is too early to warn about, and one that has ALREADY expired is not warned
 *  about at all, because the failure has happened and dunning owns it. */
export const EXPIRING_CARD_DAYS_AHEAD = 30;

export const CRON_SCHEDULE_DAILY = "0 3 * * *"; // 03:00 UTC, retention sweeps
export const CRON_SCHEDULE_MONTHLY = "0 4 1 * *"; // 04:00 UTC on the 1st, billing run
// Monday 08:00 UTC, legacy's weekly-digest cadence verbatim (session 55). The
// FIRST new cron expression this repo has needed: every other job reuses the
// tick, daily or monthly schedules.
export const CRON_SCHEDULE_WEEKLY = "0 8 * * 1";
/**
 * The merged monthly audit: 09:00 UTC on the 1st, which is LEGACY'S HOUR.
 *
 * 316 registered the audit digest on CRON_SCHEDULE_MONTHLY (04:00) and argued
 * the hour was invisible to the merchant because the promise is the DAY. That
 * held while the job only read Foxhound's own rows. It does not hold now: the
 * merged job runs the real audit against the merchant's live Stripe account on
 * the same morning as `billing-monthly` and `intelligence-sync`, and stacking a
 * per-account Stripe walk plus an AI call on the hour that already carries the
 * billing run is a self-inflicted collision. Legacy's 09:00 separates them, and
 * legacy's hour is the spec under the prime directive anyway.
 *
 * The SECOND new cron expression this repo has needed. Adding one has three
 * sites and all three are covered: this constant, the wrangler.jsonc triggers
 * array, and alerts.server.ts's SCHEDULE_PERIOD_MS, without which cron-health
 * reports the job as an unknown-schedule blind spot rather than judging its
 * staleness. A derived plant asserts all three agree.
 */
export const CRON_SCHEDULE_MONTHLY_AUDIT = "0 9 1 * *";
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

/** D1's DOCUMENTED ceiling on bound parameters in ONE query.
 *
 *  Measured from Cloudflare's own limits page (developers.cloudflare.com/d1/
 *  platform/limits/, "Maximum bound parameters per query"), not from memory,
 *  because a remembered number is what let this ship. Recorded next to the
 *  OBSERVED figure that broke: retention-health-score built a DELETE with
 *  **417** placeholders, one per aged row, and failed every day for 29 days
 *  (2026-07-22 to 2026-08-19) with rows_processed 0.
 *
 *  A query whose parameter count scales with ROW COUNT is the bug class. Prefer
 *  a set-based predicate that needs no id list at all; batch under this ceiling
 *  only where the id list is semantically required. */
export const D1_MAX_BOUND_PARAMS = 100;

/** Ids per DELETE where an id list is unavoidable. Ten percent under the
 *  documented ceiling, so a caller that adds one incidental bound parameter to
 *  the same statement does not silently cross it. */
export const DELETE_ID_BATCH_SIZE = 90;

// ---- Audit product (Phase 6 Pass 3: full-audit lift-band data/query layer) ----
/** Trailing window the audit scans for failed/recovered invoices (legacy parity). */
export const AUDIT_LOOKBACK_DAYS = 90;
/** Bounded work per audit run: caps Stripe invoice pagination (mirrors RETENTION_SWEEP_LIMIT). */
export const AUDIT_MAX_INVOICES_SCANNED = 2000;
/** Stripe's events API retains 30 days regardless of the audit's lookback, so the
 *  Card Updater signal is measured over 30 days on BOTH sides of its ratio. Legacy
 *  hardcodes the same number for the same reason and documents it in its type. */
export const CAU_EVENT_RETENTION_DAYS = 30;
/** Below this many expired-card declines in the CAU window, the absence of update
 *  events says nothing worth telling a merchant, so no advisory is raised. */
export const MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY = 3;

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
/** Reports a merchant may generate per account per hour from the Intelligence
 *  dashboard, Recova's limit (app/api/intelligence/generate-report/route.ts,
 *  RATE_LIMIT_MAX). Held by the RATE_LIMITER Durable Object, keyed per
 *  account (report-generate.server.ts). */
export const INTELLIGENCE_REPORT_HOURLY_LIMIT = 5;
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
/**
 * Connect OAuth scope at MERCHANT ONBOARDING: read_write, legacy parity.
 *
 * THIS IS REQUESTED EXACTLY ONCE IN FOXHOUND, from /connect (362 ruling 1). An
 * audit prospect who converts re-authorizes here; the audit's own flow requests
 * STRIPE_AUDIT_SCOPE below and never this.
 */
export const STRIPE_CONNECT_SCOPE = "read_write";
/**
 * Connect OAuth scope for the ANONYMOUS AUDIT: read-only, and this is the one
 * place the divergence from legacy lives.
 *
 * Legacy's app/api/audit/connect/route.ts:19 requests `read_write` for an audit,
 * so a stranger's Stripe account hands a write-capable token to a flow that
 * never writes. Its own consent screen says "We need read-only access" and lists
 * "Create new charges or move money" under what it can never do, its guide says
 * "It requests read-only access only", and Foxhound's published copy says "The
 * audit only reads." Four sentences either side, all saying read-only, around
 * one parameter that says otherwise. 362 ruling 1: the copy is the intent, so
 * the code is the defect. Class (c) truthfulness fix.
 */
export const STRIPE_AUDIT_SCOPE = "read_only";
/** CSRF state cookie name for the Connect OAuth flow. */
export const STRIPE_OAUTH_STATE_COOKIE = "stripe_oauth_state";
/**
 * CSRF state cookie name for the AUDIT OAuth flow. Legacy's own name, verbatim.
 *
 * A SECOND NAME, NOT A SHARED ONE, and legacy separates them for the reason that
 * matters: the two flows can be in flight in one browser at once. A merchant
 * halfway through /connect who opens the audit would otherwise have their
 * connect state overwritten and land on `invalid_state` at the end of a flow
 * they started correctly.
 */
export const AUDIT_OAUTH_STATE_COOKIE = "audit_oauth_state";
/** Connect OAuth state cookie lifetime: 10 minutes (legacy parity). */
export const STRIPE_OAUTH_STATE_TTL_SECONDS = 600;
/**
 * The anonymous audit's access-token cookie, at legacy's semantics exactly
 * (app/audit/callback/route.ts:51-56): HttpOnly, Secure, SameSite=Lax, five
 * minutes, scoped to /audit.
 *
 * THE COOKIE IS THE WHOLE GRANT, on both sides. Legacy stores the audit token in
 * no table (the name occurs twice in its tree: the callback sets it, the results
 * page reads it) and never deauthorizes, so five minutes is the entire window in
 * which anything can use it. Foxhound stores it in no table either.
 */
export const AUDIT_TOKEN_COOKIE = "audit_access_token";
/** Audit access-token cookie lifetime: 5 minutes (legacy parity). */
export const AUDIT_TOKEN_TTL_SECONDS = 300;
/**
 * The audit OAuth pair's IP rate limit: legacy's RATE_LIMIT_AUDIT
 * (lib/constants.ts:111), 10 per hour, applied to the start and the callback.
 * Spent through the EXISTING limiter (311) with no change to it.
 */
export const RATE_LIMIT_AUDIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;

/**
 * The unsubscribe page's IP rate limit (row F7): Recova's
 * app/api/unsubscribe/route.ts allows 10 requests per 60 seconds per IP and
 * answers the rest 429 "Too many requests". Spent through the EXISTING limiter
 * (311) on its own bucket, from the route's middleware, with no change to it.
 */
export const RATE_LIMIT_UNSUBSCRIBE = { max: 10, windowMs: 60 * 1000 } as const;

/**
 * The merchant MCP endpoint's AUTHENTICATED bucket, keyed on the api_keys row id.
 *
 * 120 PER MINUTE, and the reasoning rather than a round number: an agent
 * commonly fans out several tool calls per user turn, and a read-only surface
 * has no write to serialize, so two per second sustained is generous for real
 * use. It is low enough that a runaway agent loop is capped inside a minute
 * rather than discovering itself in a bill. Keyed on the KEY, not the IP,
 * because the caller of a server-to-server endpoint is the credential and its
 * address may move.
 */
export const RATE_LIMIT_MCP = { max: 120, windowMs: 60 * 1000 } as const;
/**
 * The UNAUTHENTICATED bucket, keyed on cf-connecting-ip, spent only when
 * authentication FAILS.
 *
 * 20 PER MINUTE, matching the existing `public` bucket's number rather than
 * inventing one. The only thing an unauthenticated caller can obtain here is a
 * 401, so twenty is generous for a misconfigured client retrying and tight
 * against guessing at the key space. It is deliberately NOT spent on successful
 * requests: a per-IP cap on authenticated traffic would break a team behind one
 * NAT for no security gain, since a real agent is already bounded by its own key
 * bucket above.
 */
export const RATE_LIMIT_MCP_ANON = { max: 20, windowMs: 60 * 1000 } as const;

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

/**
 * The CSP report sink's per-IP bucket (/api/csp-report, J22), keyed on
 * cf-connecting-ip and spent through the EXISTING limiter (311) with no change
 * to it, as the audit pair does. Recova capped the same endpoint per IP
 * (RATE_LIMIT_CSP_REPORT in its lib/constants.ts) to protect its Sentry quota;
 * here it bounds Workers Logs lines from one misbehaving browser or a flood.
 *
 * 20 PER MINUTE, the existing `public` bucket's number rather than an invented
 * one (as RATE_LIMIT_MCP_ANON reasons). Recova's own value was not readable
 * when this was written (Capsid's GitHub reads were rate limited); compare it
 * and take Recova's if it differs. With at most CSP_REPORT_MAX_LOGGED lines a
 * request, one address can write at most 100 lines a minute.
 */
export const RATE_LIMIT_CSP_REPORT = { max: 20, windowMs: 60 * 1000 } as const;

// ============================================================================
// OAuth provider for external agents (J79, rows A9, F18, F19; ruling 8)
// ============================================================================

/** An access token lives one hour, as Recova's token route said
 *  (app/api/oauth/token/route.ts, ACCESS_TOKEN_TTL_SECONDS = 3600). */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

/** A refresh token lives 30 days from its last rotation, as Recova's comment
 *  on its token route said ("rotates refresh tokens (30d) on every refresh"). */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** An authorization code lives ten minutes, the ceiling RFC 6749 section 4.1.2
 *  recommends. Recova's lifetime was a Supabase column default outside its
 *  repo, so it could not be read; this is Foxhound's own. */
export const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;

/** Recova's four OAuth limits (lib/constants.ts lines 116 to 119), unchanged:
 *  approve is per signed-in user, the other three per IP. */
export const RATE_LIMIT_OAUTH_APPROVE = { max: 20, windowMs: 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_TOKEN = { max: 30, windowMs: 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REGISTER = { max: 10, windowMs: 60 * 60 * 1000 } as const;
export const RATE_LIMIT_OAUTH_REVOKE = { max: 30, windowMs: 60 * 1000 } as const;
