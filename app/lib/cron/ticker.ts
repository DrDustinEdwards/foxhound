import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_TICKER_INSTANCE_NAME,
  CRON_TICKER_INTERVAL_MS,
} from "~/lib/constants";

import type { CronJob } from "./registry";
import { runCronJob } from "./run";

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

/** The two alarm calls the ticker needs, so a test can drive it without a
 *  Durable Object. DurableObjectStorage satisfies it. */
export interface TickerAlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** Set the alarm only if none is set. Returns true when it set one.
 *
 *  ONLY IF NONE IS SET, and that matters: every queue batch calls this, and an
 *  arm that always reset the alarm would keep pushing the next tick five minutes
 *  away, so a busy queue would stop the jobs it is meant to keep running. */
export async function armTickerIfIdle(storage: TickerAlarmStorage, now: number = Date.now()): Promise<boolean> {
  if ((await storage.getAlarm()) !== null) return false;
  await storage.setAlarm(now + CRON_TICKER_INTERVAL_MS);
  return true;
}

export interface TickerDeps {
  now: () => number;
  run: typeof runCronJob;
  /** The jobs to run. Dynamic by default for the reason scheduled() gives: the
   *  registry's billing, AI and recovery graph stays out of module init. */
  jobs: () => Promise<CronJob[]>;
}

const defaultDeps: TickerDeps = {
  now: () => Date.now(),
  run: runCronJob,
  jobs: async () => {
    const { jobsForSchedule } = await import("./registry");
    return [...jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK), ...jobsForSchedule(CRON_SCHEDULE_BLOG)];
  },
};

/** The alarm: re-arm FIRST, then run every job on the five-minute schedule,
 *  and blog-schedules after them.
 *
 *  Re-arming before the jobs is what keeps the chain alive. A job that throws,
 *  runs until the platform kills the invocation, or fails to import would
 *  otherwise leave no alarm behind and the ticker would stop for good, which is
 *  the failure this exists to get away from. runCronJob never throws, so the
 *  jobs run one after another with no guard of their own, as in scheduled(). */
export async function runTickerAlarm(
  env: Env,
  storage: TickerAlarmStorage,
  deps: TickerDeps = defaultDeps,
): Promise<void> {
  await storage.setAlarm(deps.now() + CRON_TICKER_INTERVAL_MS);
  for (const job of await deps.jobs()) {
    await deps.run(env, job.name, job.handler);
  }
}

/** Ask the ticker to make sure its alarm is set. Called from scheduled() and
 *  queue(), never from fetch(). It never throws: a failed arm must not stop the
 *  cron jobs or fail a queue batch, and the next caller tries again. */
export async function ensureCronTickerArmed(env: Env): Promise<void> {
  try {
    const ns = env.CRON_TICKER;
    await ns.get(ns.idFromName(CRON_TICKER_INSTANCE_NAME)).ensureArmed();
  } catch (err) {
    console.error("cron ticker arm failed", err instanceof Error ? err.message : err);
  }
}
