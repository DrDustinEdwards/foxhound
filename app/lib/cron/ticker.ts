import { ensureTickerArmed } from "@dustinedwards/site-runtime/cron-lock";

import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_TICKER_INSTANCE_NAME,
} from "~/lib/constants";

import type { CronJob } from "./registry";
import { runCronJob, runScheduledJobs } from "./run";

// THE FIVE-MINUTE TICKER, the logic half. workers/cron-ticker.ts is the Durable
// Object shell; it imports "cloudflare:workers" and cannot load under vitest, so
// what it does lives here, as cron-lock.ts and lock-state.ts are split.
//
// WHY IT EXISTS. From 2026-10-23 19:08 UTC Cloudflare stopped firing the
// "*/5 * * * *" trigger in production while still listing it, and while the
// daily and weekly triggers and Durable Object alarms kept firing. That
// schedule carries recovery-tick, winback-send and dispute-reminders, so all
// three stopped. The ticker runs the same jobs from a Durable Object alarm, so
// they no longer depend on that one trigger. The trigger stays in wrangler.jsonc
// as a backup.
//
// NOTHING ABOUT THE JOBS CHANGES. Each runs through runCronJob, so cron_config,
// the minimum interval, the CRON_LOCK lease and cron_run_history all apply as
// they do for a trigger run. If the trigger comes back, a trigger run and an
// alarm run in the same window meet the lock (one skips as "locked") or run one
// after the other, and the per-step and per-send claims stop any double charge
// or double send, as they already do for overlapping trigger runs.
//
// BLOG SCHEDULES RIDE ALONG. blog-schedules has its own "* * * * *" trigger, so a
// post Carrel scheduled goes live within a minute. That trigger is new and may
// fail the way "*/5" did, so the ticker runs blog-schedules too: if the minute
// trigger never fires, a scheduled post still goes live within five minutes.
// runSchedules applies only what is due and still matches, so a second run in
// the same minute applies nothing.

export interface TickerDeps {
  run: typeof runCronJob;
  /** The jobs to run. Dynamic by default for the reason scheduled() gives: the
   *  registry's billing, AI and recovery graph stays out of module init. */
  jobs: () => Promise<CronJob[]>;
}

const defaultDeps: TickerDeps = {
  run: runCronJob,
  jobs: async () => {
    const { jobsForSchedule } = await import("./registry");
    return [
      ...jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK),
      ...jobsForSchedule(CRON_SCHEDULE_BLOG),
    ];
  },
};

/** One tick's jobs: every job on the five-minute schedule, and blog-schedules
 *  after them, through runScheduledJobs so each lands in cron_runs. The shared
 *  CronTicker (workers/cron-ticker.ts) re-arms the alarm BEFORE calling this and
 *  swallows and logs this one's closing throw, which a retried alarm would
 *  otherwise turn into a second run of the jobs. */
export async function runTickerJobs(env: Env, deps: TickerDeps = defaultDeps): Promise<void> {
  await runScheduledJobs(env, await deps.jobs(), deps.run);
}

/** Ask the ticker to make sure its alarm is set. Called from scheduled() and
 *  queue(), never from fetch(). Never throws (the shared ensureTickerArmed logs). */
export function ensureCronTickerArmed(env: Env): Promise<void> {
  return ensureTickerArmed(env.CRON_TICKER, CRON_TICKER_INSTANCE_NAME);
}
