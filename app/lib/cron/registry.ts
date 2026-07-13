import { runMonthlyBilling } from "~/lib/billing/run";
import { CRON_SCHEDULE_DAILY, CRON_SCHEDULE_MONTHLY } from "~/lib/constants";

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

/** The monthly billing run, wrapped as a cron handler (reports invoices created). */
const billingMonthly: CronHandler = async (env) => {
  const results = await runMonthlyBilling(env, Date.now());
  const applied = results.flatMap((r) => r.invoices).filter((i) => i.applied);
  return {
    rowsProcessed: applied.length,
    message: `${results.length} accounts, ${applied.length} invoices`,
  };
};

export const CRON_JOBS: CronJob[] = [
  { name: "billing-monthly", schedule: CRON_SCHEDULE_MONTHLY, handler: billingMonthly },
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
