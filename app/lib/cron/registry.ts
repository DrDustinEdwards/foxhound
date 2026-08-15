import { getDb } from "~/db";
import { describeSweepRun, runMonthlyBilling } from "~/lib/billing/run";
import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_RECOVERY_TICK,
  RECOVERY_TICK_CRON_NAME,
} from "~/lib/constants";
import { DEMO_RESET_CRON_NAME } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { runIntelligenceAiForAllAccounts } from "~/lib/intelligence/ai-run.server";
import { runIntelligenceSyncForAllAccounts } from "~/lib/intelligence/sync.server";

import { runCronHealthCheck } from "./alerts.server";
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
const billingMonthly: CronHandler = async (env) => {
  const { accounts, sweep } = await runMonthlyBilling(env, Date.now());
  const applied = accounts.flatMap((r) => r.invoices).filter((i) => i.applied);
  return {
    rowsProcessed: applied.length,
    message: `${accounts.length} accounts, ${applied.length} invoices, ${describeSweepRun(sweep)}`,
  };
};

/** The Intelligence deterministic sync (customer_context signals +
 *  mrr_snapshots, the free MRR tier), wrapped as a cron handler. Runs monthly,
 *  alongside billing: MRR movements are a monthly measure (new/expansion/
 *  contraction/churn/reactivation are computed against the PRIOR run's
 *  customer_context state), and the dashboard already labels snapshots by
 *  month and captions the movements chart "latest month" (dashboard.tsx). A
 *  daily cadence would silently mismatch both: "latest 12" would cover under
 *  two weeks instead of a year, and "latest month" would show one day's
 *  movement. CRON_SCHEDULE_MONTHLY is already registered in wrangler.jsonc
 *  (billing-monthly uses it), so this needs no deploy-config change either. */
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

/** The recovery tick (Phase 4e): sweeps due recovery_steps and runs each through
 *  its executor. High cadence (every 5 minutes) because it drives real-time
 *  retries + dunning sends; see app/lib/cron/recovery-tick.ts. */
const recoveryTick: CronHandler = (env, ctx) => runRecoveryTick(env, {}, ctx?.runId ?? null);

/** The Intelligence AI half (health scoring -> predictions -> alerts ->
 *  nightly narrative), wrapped as a cron handler. Runs on the daily/nightly
 *  schedule (PRICING.md: "nightly AI analyst narrative"), reusing
 *  CRON_SCHEDULE_DAILY rather than a new wrangler.jsonc trigger. Score/
 *  predict/alert always commit; the narrative fails safe (a skipped narrative
 *  is visible in the message, never a failed run). */
const intelligenceAi: CronHandler = async (env) => {
  const results = await runIntelligenceAiForAllAccounts(env, Date.now());
  const customersScored = results.reduce((sum, r) => sum + r.customersScored, 0);
  const alertsFired = results.reduce((sum, r) => sum + r.alertsFired, 0);
  const narrativesGenerated = results.filter((r) => r.narrativeGenerated).length;
  const skipped = results.filter((r) => r.narrativeSkippedReason !== null).length;
  const skippedNote = skipped > 0 ? `, ${skipped} narrative(s) skipped` : "";
  return {
    rowsProcessed: customersScored,
    message:
      `${results.length} accounts, ${customersScored} customers scored, ` +
      `${alertsFired} alerts fired, ${narrativesGenerated} narratives generated${skippedNote}`,
  };
};

/** The demo-account reset: wipes and rebuilds the seeded demo account daily, so a
 *  prospect clicking around cannot leave it broken for the next visitor. The
 *  seeder is deterministic + idempotent and makes no Stripe/AI call; the demo
 *  account is firewalled out of every other cron by its DEMO_ACCOUNT_ID_PREFIX. */
const demoReset: CronHandler = async (env) => {
  await seedDemoAccount(getDb(env), new Date());
  return { rowsProcessed: 1, message: "demo account reseeded" };
};

/** The never-executed and overdue detector (313). Ruling 311 measured that a cron
 *  which fails, or never runs at all, notifies nobody: billing-monthly has never
 *  executed once in any environment and nothing would have said so.
 *
 *  It reads CRON_JOBS at CALL time rather than module-init time, which is what
 *  makes the self-reference below safe: the array is fully constructed long
 *  before any cron fires. Expectations are therefore DERIVED from the registry,
 *  so a job added tomorrow is watched automatically instead of being forgotten. */
const cronHealth: CronHandler = async (env) =>
  runCronHealthCheck(env, getDb(env), CRON_JOBS, new Date());

export const CRON_JOBS: CronJob[] = [
  { name: RECOVERY_TICK_CRON_NAME, schedule: CRON_SCHEDULE_RECOVERY_TICK, handler: recoveryTick },
  { name: "cron-health", schedule: CRON_SCHEDULE_DAILY, handler: cronHealth },
  { name: DEMO_RESET_CRON_NAME, schedule: CRON_SCHEDULE_DAILY, handler: demoReset },
  { name: "billing-monthly", schedule: CRON_SCHEDULE_MONTHLY, handler: billingMonthly },
  { name: "intelligence-sync", schedule: CRON_SCHEDULE_MONTHLY, handler: intelligenceSync },
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
