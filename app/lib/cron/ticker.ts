import { ensureTickerArmed } from "@dustinedwards/site-runtime/cron-lock";

import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_TICKER_INSTANCE_NAME,
} from "~/lib/constants";

import { runScheduledJobs } from "./run";

// THE FIVE-MINUTE TICKER, the logic half. workers/cron-ticker.ts is the Durable
// Object shell; it imports "cloudflare:workers" and cannot load under vitest,
// so what it does lives here, as cron-lock.ts and lock-state.ts are split.
//
// If the trigger comes back, a trigger run and an alarm run in the same window
// meet the lock (one skips as "locked") or run one after the other, and the
// per-step and per-send claims stop any double charge or double send, as they
// already do for overlapping trigger runs.

/**
 * One tick's jobs: every job on the five-minute schedule, and blog-schedules
 * after them, through runScheduledJobs so each lands in cron_runs. The shared
 * CronTicker (workers/cron-ticker.ts) re-arms the alarm BEFORE calling this and
 * swallows and logs this one's closing throw, which a retried alarm would
 * otherwise turn into a second run of the jobs.
 */
export async function runTickerJobs(env: Env): Promise<void> {
  // Dynamic for the reason scheduled() gives: the registry's billing, AI and recovery graph stays out of module init.
  const { jobsForSchedule } = await import("./registry");
  await runScheduledJobs(env, [
    ...jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK),
    ...jobsForSchedule(CRON_SCHEDULE_BLOG),
  ]);
}

/**
 * Ask the ticker to make sure its alarm is set. Called from scheduled() and
 * queue(), never from fetch(). Never throws (the shared ensureTickerArmed
 * logs).
 */
export function ensureCronTickerArmed(env: Env): Promise<void> {
  return ensureTickerArmed(env.CRON_TICKER, CRON_TICKER_INSTANCE_NAME);
}
