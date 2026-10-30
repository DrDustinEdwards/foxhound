import { getDb } from "~/db";
import { describeMonthlyAuditRun, enqueueMonthlyAudits } from "~/lib/audit/monthly.server";
import { creditOwedFeeLines, creditSweepFailureError, describeCreditSweep } from "~/lib/billing/credit-note";
import { computeBillingPeriod, describeSweepRun, runMonthlyBilling } from "~/lib/billing/run";
import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_EXPIRING_CARDS,
  CRON_SCHEDULE_WEEKLY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  RECOVERY_TICK_CRON_NAME,
} from "~/lib/constants";
import { runBlogSchedules } from "~/lib/carrel/handler.server";
import { DEMO_BUSINESSES, DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { runIntelligenceAiForAllAccounts } from "~/lib/intelligence/ai-run.server";
import { runAlertsForAllAccounts } from "~/lib/intelligence/alert-run.server";
import { runIntelligenceSyncForAllAccounts } from "~/lib/intelligence/sync.server";
import { upgradeMissedRetryAttributions } from "~/lib/recovery/record-recovery";

import { runD1Backup } from "~/lib/backup/d1-backup";
import {
  deauthorizeRetryFailureError,
  describeDeauthorizeRetry,
  retryFailedDeauthorizations,
} from "~/lib/stripe/deauthorize-retry.server";
import {
  describeDisputeReminderRun,
  DISPUTE_REMINDERS_CRON_NAME,
  runDisputeReminders,
} from "~/lib/cron/dispute-reminders";
import { describeDisputeAutoSubmitRun, runDisputeAutoSubmit } from "~/lib/cron/dispute-auto-submit";
import { describeExpiringCardRun, runExpiringCards } from "~/lib/cron/expiring-cards";
import {
  describeDisputeFeePricing,
  disputeFeePricingFailureError,
  priceUnpricedDisputeFees,
} from "~/lib/disputes/fee-pricing.server";
import { describeWeeklyDigestRun, runWeeklyDigest } from "~/lib/cron/digest";
import { describeMissedEventSweep, sweepMissedStripeEvents } from "~/lib/webhooks/missed-events.server";
import { describeWinbackRun, runWinbackSends } from "~/lib/cron/winback";
import { alertCronFailure, billingFailureError, runCronHealthCheck } from "./alerts.server";
import { runRecoveryTick } from "./recovery-tick";
import type { CronHandler } from "./run";
import {
  sweepAiCalls,
  sweepCronRunHistory,
  sweepEmailSends,
  sweepEngagementEvents,
  sweepHealthScoreHistory,
  sweepPage404Daily,
  sweepSocialLeads,
  sweepWebhookEvents,
} from "./retention";

// The scheduled-job registry: the single list mapping cron schedules to handlers.
// The scheduled() handler in workers/app.ts dispatches by controller.cron to every
// job on that schedule; each goes through runCronJob (config gate + interval gate
// + per-cron DO lock + cron_run_history). Every schedule here MUST appear in
// wrangler.jsonc triggers.crons, or the job never fires (guarded by a test).

export interface CronJob {
  name: string;
  schedule: string;
  handler: CronHandler;
}

/** The monthly billing run, wrapped as a cron handler (reports invoices created
 *  AND what the charge-retry sweep did).
 *
 *  The sweep clause is not decoration. The sweep aborts rather than continuing
 *  when it cannot read the billing gate, and until this line carried its status
 *  that abort was a console.error and nothing else: the cron row said "success"
 *  with a count, and an operator could not tell a sweep that found nothing from
 *  a sweep that never looked. The run itself is still a success, because the
 *  new-period billing below the sweep really did complete. */
const billingMonthly: CronHandler = async (env, ctx) => {
  const nowMs = Date.now();
  const { accounts, sweep } = await runMonthlyBilling(env, nowMs);
  // A human hears about per-account failures (E26), as Recova's
  // process-recovery-billing does; the run itself still succeeds.
  const failure = billingFailureError(
    accounts.filter((r) => r.error !== undefined).map((r) => r.accountId),
    computeBillingPeriod(nowMs).periodStart,
  );
  if (failure) {
    await alertCronFailure(env, getDb(env), { cronName: "billing-monthly", runId: ctx?.runId ?? null, error: failure }, new Date(nowMs));
  }
  const applied = accounts.flatMap((r) => r.invoices).filter((i) => i.applied);
  return {
    rowsProcessed: applied.length,
    message: `${accounts.length} accounts, ${applied.length} invoices, ${describeSweepRun(sweep)}`,
  };
};

/** The Intelligence deterministic sync (customer_context signals +
 *  mrr_snapshots, the free MRR tier), wrapped as a cron handler. Runs daily,
 *  as Recova's compute-intelligence-mrr did: each row's movements are measured
 *  against the PRIOR run's customer_context state, so one row is one day's
 *  movement, and the dashboard reads 90 days of them (trends.server.ts) while
 *  the console rolls them up by month (getMrrAnalytics). It runs before
 *  intelligence-ai in CRON_JOBS so the narrative reads today's row. */
const intelligenceSync: CronHandler = async (env) => {
  const results = await runIntelligenceSyncForAllAccounts(env, Date.now());
  const customersProcessed = results.reduce((sum, r) => sum + r.customersProcessed, 0);
  const snapshotsWritten = results.filter((r) => r.snapshotWritten).length;
  const truncatedAccounts = results.filter((r) => r.truncated).length;
  const truncatedNote =
    truncatedAccounts > 0
      ? `, ${truncatedAccounts} TRUNCATED (raise INTELLIGENCE_MAX_CUSTOMERS_SCANNED)`
      : "";
  return {
    rowsProcessed: customersProcessed,
    message: `${results.length} accounts, ${snapshotsWritten} snapshots, ${customersProcessed} customers${truncatedNote}`,
  };
};

/** The recovery tick: sweeps due recovery_steps and runs each through
 *  its executor. High cadence (every 5 minutes) because it drives real-time
 *  retries + dunning sends; see app/lib/cron/recovery-tick.ts. */
const recoveryTick: CronHandler = (env, ctx) => runRecoveryTick(env, {}, ctx?.runId ?? null);

/** Recova's evaluateAlerts, which ran at the tail of its recovery cron: every
 *  account's alerts against its eleven metrics, then the critical customers
 *  check. On the recovery tick's schedule and listed after it and the dispute
 *  reminders, so it reads what they just did; the 24 hour cooldown keeps each alert to one
 *  message a day (app/lib/intelligence/alert-run.server.ts). */
const alertsEvaluate: CronHandler = async (env) => {
  const { accounts, fired } = await runAlertsForAllAccounts(env, Date.now());
  return { rowsProcessed: fired, message: `${accounts} accounts, ${fired} alerts fired` };
};

/** Intelligence's nightly run (health scoring -> predictions -> the month's
 *  narrative), wrapped as a cron handler on the daily schedule, reusing
 *  CRON_SCHEDULE_DAILY rather than a new wrangler.jsonc trigger. No model call:
 *  the narrative is a template (narrative.ts). One account's failure is
 *  visible in the message, never a failed run. */
const intelligenceAi: CronHandler = async (env) => {
  const results = await runIntelligenceAiForAllAccounts(env, Date.now());
  const customersScored = results.reduce((sum, r) => sum + r.customersScored, 0);
  const failed = results.filter((r) => r.error !== null).length;
  const failedNote = failed > 0 ? `, ${failed} account(s) failed` : "";
  return {
    rowsProcessed: customersScored,
    message: `${results.length} accounts, ${customersScored} customers scored${failedNote}`,
  };
};

/** Scheduled blog publishing (site-api v0.10.0): puts live every post and
 *  every update to a live post whose scheduled time has come, and tells
 *  IndexNow about each. A schedule that fails is logged by site-api and listed
 *  again on the next pass, so the run stays a success and says so. */
const blogSchedules: CronHandler = async (env) => {
  const run = await runBlogSchedules(env);
  const failed = run.failed > 0 ? `, ${run.failed} failed (retried next pass)` : "";
  const more = run.more ? ", more due" : "";
  return {
    rowsProcessed: run.applied.length,
    message: `${run.applied.length} applied, ${run.skipped} skipped${failed}${more}`,
  };
};

/** The demo-account reset: wipes and rebuilds both seeded demo businesses
 *  (Teamflow, Bolt Analytics) daily, so a prospect clicking around cannot leave
 *  them broken for the next visitor. The seeder is deterministic + idempotent
 *  and makes no Stripe/AI call; the demo accounts are firewalled out of every
 *  other cron by their DEMO_ACCOUNT_ID_PREFIX. */
const demoReset: CronHandler = async (env) => {
  await seedDemoAccount(getDb(env), new Date());
  return { rowsProcessed: DEMO_BUSINESSES.length, message: `${DEMO_BUSINESSES.length} demo accounts reseeded` };
};

/** The never-executed and overdue detector. Ruling 311 measured that a cron
 *  which fails, or never runs at all, notifies nobody: billing-monthly has never
 *  executed once in any environment and nothing would have said so.
 *
 *  It reads CRON_JOBS at CALL time rather than module-init time, which is what
 *  makes the self-reference below safe: the array is fully constructed long
 *  before any cron fires. Expectations are therefore DERIVED from the registry,
 *  so a job added tomorrow is watched automatically instead of being forgotten. */
/** The daily expiring-card alert. Two passes in one job, like legacy:
 *  scan every connected account's active subscriptions for cards inside the
 *  30-day lead window and record a candidate, then send one customer-facing
 *  warning per unsent candidate. CRON_SCHEDULE_EXPIRING_CARDS is legacy's
 *  "0 9 * * *" (vercel.json, /api/cron/expiring-cards): it rode the 03:00
 *  daily sweep until parity gap 11, which landed the email in the middle of
 *  the US night. The CronLockDurableObject lease in run.ts is what stops two
 *  ticks scanning at once. */
/** The win-back send pass. Legacy's own header says it "Runs hourly
 *  via Vercel Cron (piggybacking on process-recovery schedule)", so its cadence
 *  IS the recovery cron's cadence, and CRON_SCHEDULE_RECOVERY_TICK is that
 *  cadence here. Reusing it needs no new wrangler.jsonc trigger, which is the
 *  same reasoning intelligence-sync and intelligence-ai already record.
 *
 *  It fires more often than legacy's hour, never less, and that is a fidelity
 *  gain rather than a divergence: legacy's own constant asks for step 1 "1 hour
 *  after cancellation" and hourly polling delivers it up to two hours late. The
 *  CronLockDurableObject lease in run.ts is what stops two ticks sending at
 *  once, and the per-step claim is what stops a double send if one ever did. */
/** The weekly merchant digest. Legacy runs it
 *  Monday 08:00 UTC and this matches, which needed the FIRST new wrangler cron
 *  expression this repo has added: every other job reuses the five-minute
 *  tick, daily or monthly. NULL is OFF on digest_enabled, the one toggle with
 *  that semantic. */
const weeklyDigest: CronHandler = async (env) => {
  const result = await runWeeklyDigest(env, new Date());
  return { rowsProcessed: result.sent, message: describeWeeklyDigestRun(result) };
};

const winbackSend: CronHandler = async (env) => {
  const result = await runWinbackSends(env, new Date());
  return { rowsProcessed: result.sent, message: describeWinbackRun(result) };
};

/** The dispute deadline reminder. Recova's process-disputes ran hourly
 *  ("0 * * * *"); this rides the five-minute tick instead, as winback-send does,
 *  because a new cron expression needs cron-health's period table too and the
 *  bands are a day wide, so a finer tick only reminds sooner within the band.
 *  The per-band send claim is what stops a second reminder. Recova's
 *  "Thing 2", the opt-in auto-submit 24 hours before the deadline, runs on the
 *  same tick after the reminders, as it ran after them in process-disputes. */
const disputeReminders: CronHandler = async (env, ctx) => {
  const now = new Date();
  const result = await runDisputeReminders(env, now, ctx?.runId ?? null);
  const auto = await runDisputeAutoSubmit(env, now, ctx?.runId ?? null);
  return {
    rowsProcessed: result.sent + auto.submitted,
    message: `${describeDisputeReminderRun(result)}; ${describeDisputeAutoSubmitRun(auto)}`,
  };
};

const expiringCards: CronHandler = async (env) => {
  const result = await runExpiringCards(env, new Date());
  return { rowsProcessed: result.send.sent, message: describeExpiringCardRun(result) };
};

/** The nightly D1 dump into R2. Reuses the daily schedule, so no
 *  new wrangler.jsonc trigger. See app/lib/backup/d1-backup.ts. */
const d1Backup: CronHandler = (env) => runD1Backup(env, new Date());

/** The credit-note retry (Grok audit FH-2). A refund or lost dispute credits
 *  its charged fee from the webhook, and that call never throws, so a Stripe
 *  failure there used to be a console line and a fee kept for good: the
 *  redelivery is a duplicate and skips the clawback. This sweep credits every
 *  fee the ledger says is owed, daily, until it is. A fee still owed after the
 *  sweep alerts, as billing-monthly's per-account failures do.
 *
 *  It also runs the retry-attribution sweep first (upgradeMissedRetryAttributions):
 *  a recovery the webhook recorded as stripe_baseline after the retry's short
 *  reconcile window had closed is upgraded to foxhound_retry, daily and before
 *  the 04:00 billing run on the 1st, so the ledger's attribution is right
 *  before anything reads it for billing. */
const creditNoteRetry: CronHandler = async (env, ctx) => {
  const now = new Date();
  const attribution = await upgradeMissedRetryAttributions(env, now);
  const result = await creditOwedFeeLines(env, now);
  const failures = [
    creditSweepFailureError(result),
    attribution.failed.length > 0
      ? `${attribution.failed.length} retry attribution upgrade(s) failed: ${attribution.failed.map((f) => `${f.failedPaymentId}: ${f.error}`).join("; ")}`
      : null,
  ].filter((f): f is string => f !== null);
  if (failures.length > 0) {
    await alertCronFailure(
      env,
      getDb(env),
      { cronName: "credit-note-retry", runId: ctx?.runId ?? null, error: failures.join(" | ") },
      now,
    );
  }
  return {
    rowsProcessed: result.credited + attribution.upgraded,
    message: `${describeCreditSweep(result)}; ${attribution.upgraded} retry attribution(s) upgraded`,
  };
};

/** The dispute fee pricing retry ("Skip until priced", Dustin 2026-10-25). A
 *  won dispute whose cap could not be converted at resolution is skipped by
 *  billing until its fee is stored; this prices it daily, tells the merchant,
 *  and alerts while any stays unpriced. 03:00 daily runs before the 04:00
 *  billing run on the 1st. */
const disputeFeePricing: CronHandler = async (env, ctx) => {
  const now = new Date();
  const result = await priceUnpricedDisputeFees(env, now, ctx?.runId ?? null);
  const failure = disputeFeePricingFailureError(result);
  if (failure) {
    await alertCronFailure(env, getDb(env), { cronName: "dispute-fee-pricing", runId: ctx?.runId ?? null, error: failure }, now);
  }
  return { rowsProcessed: result.priced, message: describeDisputeFeePricing(result) };
};

/** The Stripe grant revoke retry (Grok audit FH-7). Cancel, disconnect and
 *  account deletion revoke the grant after the local disconnect, and a failed
 *  revoke is queued on the connection row. This retries each daily until
 *  Stripe accepts, and alerts while any grant is still in place. */
const stripeDeauthorizeRetry: CronHandler = async (env, ctx) => {
  const now = new Date();
  const db = getDb(env);
  const result = await retryFailedDeauthorizations(env, db);
  const failure = deauthorizeRetryFailureError(result);
  if (failure) {
    await alertCronFailure(env, db, { cronName: "stripe-deauthorize-retry", runId: ctx?.runId ?? null, error: failure }, now);
  }
  return { rowsProcessed: result.revoked + result.superseded, message: describeDeauthorizeRetry(result) };
};

/** The missed-event sweep (Stripe's process-undelivered-events advice): the
 *  last four days of each live connection's events that webhook_events never
 *  claimed, replayed through the webhook route's own processor. Reuses the
 *  daily schedule, so no new wrangler.jsonc trigger. See
 *  app/lib/webhooks/missed-events.server.ts. */
const stripeMissedEvents: CronHandler = async (env) => {
  const result = await sweepMissedStripeEvents(env, new Date());
  return { rowsProcessed: result.replayed, message: describeMissedEventSweep(result) };
};

const cronHealth: CronHandler = async (env) =>
  runCronHealthCheck(env, getDb(env), CRON_JOBS, new Date());

/** THE MERGED MONTHLY AUDIT. It runs the real audit
 *  against each opted-in merchant's live Stripe account, records the run, and
 *  sends the ONE monthly email.
 *
 *  IT REPLACES `audit-digest`, WHICH IS GONE FROM THIS LIST. 316 registered a
 *  second monthly send here, gated on the same toggle and addressed to the same
 *  recipient; session 67's walk found the two on a collision course and 362
 *  ruled one email. The digest's number is now a line item in this one.
 *
 *  CRON_SCHEDULE_MONTHLY_AUDIT IS "0 9 1 * *", LEGACY'S HOUR, not the 04:00 the
 *  digest rode. 316 argued the hour was invisible to a merchant whose promise is
 *  the DAY, which was true of a job that only read Foxhound's own rows. This one
 *  walks live Stripe and calls the model per account, so putting it on the hour
 *  that already carries billing-monthly and intelligence-sync would be a
 *  self-inflicted collision. See the constant for the three sites a new
 *  expression has to land in.
 *
 *  IT ONLY ENQUEUES: one AUDIT_QUEUE message per opted-in
 *  account, audited one per invocation by the queue consumer, so one large
 *  account's Stripe pages cannot exhaust the subrequests every other account
 *  needs. rowsProcessed is the number queued; each account's own result is its
 *  audit_digest_runs row.
 *
 *  It passes the run id so a claim row can name the run that produced it. */
const monthlyAudit: CronHandler = async (env, ctx) => {
  const result = await enqueueMonthlyAudits(env, new Date(), ctx?.runId ?? null);
  return { rowsProcessed: result.enqueued, message: describeMonthlyAuditRun(result) };
};

export const CRON_JOBS: CronJob[] = [
  { name: RECOVERY_TICK_CRON_NAME, schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: recoveryTick },
  { name: "winback-send", schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: winbackSend },
  { name: DISPUTE_REMINDERS_CRON_NAME, schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: disputeReminders },
  { name: "alerts-evaluate", schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: alertsEvaluate },
  { name: "weekly-digest", schedule: CRON_SCHEDULE_WEEKLY, handler: weeklyDigest },
  { name: "blog-schedules", schedule: CRON_SCHEDULE_BLOG, handler: blogSchedules },
  { name: "cron-health", schedule: CRON_SCHEDULE_DAILY, handler: cronHealth },
  { name: "expiring-cards", schedule: CRON_SCHEDULE_EXPIRING_CARDS, handler: expiringCards },
  { name: "d1-backup", schedule: CRON_SCHEDULE_DAILY, handler: d1Backup },
  { name: DEMO_RESET_CRON_NAME, schedule: CRON_SCHEDULE_DAILY, handler: demoReset },
  { name: "credit-note-retry", schedule: CRON_SCHEDULE_DAILY, handler: creditNoteRetry },
  { name: "stripe-deauthorize-retry", schedule: CRON_SCHEDULE_DAILY, handler: stripeDeauthorizeRetry },
  { name: "stripe-missed-events", schedule: CRON_SCHEDULE_DAILY, handler: stripeMissedEvents },
  { name: "dispute-fee-pricing", schedule: CRON_SCHEDULE_DAILY, handler: disputeFeePricing },
  { name: "billing-monthly", schedule: CRON_SCHEDULE_MONTHLY, handler: billingMonthly },
  { name: "intelligence-sync", schedule: CRON_SCHEDULE_DAILY, handler: intelligenceSync },
  { name: "monthly-audit", schedule: CRON_SCHEDULE_MONTHLY_AUDIT, handler: monthlyAudit },
  { name: "intelligence-ai", schedule: CRON_SCHEDULE_DAILY, handler: intelligenceAi },
  { name: "retention-engagement-events", schedule: CRON_SCHEDULE_DAILY, handler: sweepEngagementEvents },
  { name: "retention-email-sends", schedule: CRON_SCHEDULE_DAILY, handler: sweepEmailSends },
  { name: "retention-webhook-events", schedule: CRON_SCHEDULE_DAILY, handler: sweepWebhookEvents },
  { name: "retention-health-score", schedule: CRON_SCHEDULE_DAILY, handler: sweepHealthScoreHistory },
  { name: "retention-cron-history", schedule: CRON_SCHEDULE_DAILY, handler: sweepCronRunHistory },
  { name: "retention-social-leads", schedule: CRON_SCHEDULE_DAILY, handler: sweepSocialLeads },
  { name: "retention-page-404", schedule: CRON_SCHEDULE_DAILY, handler: sweepPage404Daily },
  { name: "retention-ai-calls", schedule: CRON_SCHEDULE_DAILY, handler: sweepAiCalls },
];

/** The jobs registered for a given cron schedule string. */
export function jobsForSchedule(cron: string): CronJob[] {
  return CRON_JOBS.filter((j) => j.schedule === cron);
}
