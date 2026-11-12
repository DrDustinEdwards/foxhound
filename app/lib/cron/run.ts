import {
  runJobs,
  type CronHistory,
  type CronJob as SiteCronJob,
} from "@dustinedwards/site-runtime/cron";
import { eq } from "drizzle-orm";

import { cronConfig, cronRuns, getDb } from "~/db";
import { cronRunId } from "~/lib/admin/crons";
import { CRON_LOCK_LEASE_MS, RETENTION_CRON_LOG_DAYS } from "~/lib/constants";

import { alertCronFailure, SCHEDULE_PERIOD_MS } from "./alerts.server";
import { isCronEnabled, isDueByInterval } from "./gating";
import type { CronJob } from "./registry";

// The cron runner: every scheduled job goes through site-runtime's runJobs, which
// records it in cron_runs (what /health and cron-health read) and keeps each run
// in cron_run_log (what the admin Crons page and the alerts read). Around each
// handler Foxhound adds its three gates, in order: config-enabled, min-interval,
// the per-cron Durable Object lock. A gated run is a skip and records nothing.
//
// A job's own logic never touches cron_config or the lock; it does its work and
// reports how many rows it processed and what it did.

export interface CronJobResult {
  rowsProcessed: number;
  message?: string;
}
/** What a handler learns about the run it is executing inside: its id, so the
 *  paths that write an email_sends or audit_digest_runs row can name the run. */
interface CronRunContext {
  runId: string;
}
export type CronHandler = (env: Env, ctx?: CronRunContext) => Promise<CronJobResult>;

/** cron_run_log's bounds. The Crons page shows each job's last day of failures,
 *  and blog-schedules runs every minute, so a job keeps its newest 1,500 runs
 *  (over a day of minutes) and none older than RETENTION_CRON_LOG_DAYS, which
 *  still holds a monthly job's last run. runJobs prunes as it writes, so no
 *  retention sweep of its own. */
export const CRON_HISTORY: CronHistory = { keep: 1500, retentionDays: RETENTION_CRON_LOG_DAYS };

/** How often a job's trigger fires, in minutes: its schedule's period. cron_runs and /health's cronCheck judge it by
 *  this. */
export function cronEveryMinutes(schedule: string): number {
  return SCHEDULE_PERIOD_MS[schedule]! / 60_000;
}

/** Past this, a run is recorded failed ("timed out"): its own period, at most ten minutes, because every job on the
 *  daily 03:00 trigger shares one invocation and Cloudflare stops a Cron Trigger at fifteen. */
const CRON_OVERRUN_CAP_MS = 10 * 60_000;
function cronTimeoutMs(schedule: string): number {
  return Math.min(SCHEDULE_PERIOD_MS[schedule]!, CRON_OVERRUN_CAP_MS);
}

/** The one line cron_run_log keeps for a run that executed: the handler's
 *  message, or its row count when it has none. */
function reasonOf(result: CronJobResult): string {
  return result.message ?? `${result.rowsProcessed} rows`;
}

/**
 * One registry job as a site-runtime job, behind its gates.
 *
 * THE GATES. A job cron_config switches off, one inside its minimum interval
 * (measured from its last finish in cron_runs) and one whose lock another run
 * holds are skips: runJobs logs them and records no run they never had. A run
 * now (`now: true`, the operator's run_job) asks on purpose, so the interval does
 * not apply; the enabled gate and the lock still do.
 *
 * THE TIMEOUT MARKS, IT DOES NOT LET GO (`holdOnTimeout`). A run past
 * cronTimeoutMs is recorded failed so /health warns, but runJobs waits for it and
 * it keeps its CRON_LOCK lease until it really ends: handing the lock on while a
 * money job is still running would let a second run start beside it.
 * Cloudflare's own fifteen-minute limit is the hard stop.
 *
 * THE ALERT. Any throw, from the handler or from the gates around it (a D1 blip,
 * a lock RPC failure), mails the failure once a day through alertCronFailure,
 * which never throws, and is then rethrown so runJobs records the run failed.
 *
 * THE TOKEN IS THE FENCE. `acquire` hands back the holder's token and `release`
 * takes it, so a run frees only its own lease. A failed release is swallowed: it
 * must not turn a run that succeeded into a failure, and the lease lapses anyway.
 */
function gatedJob(env: Env, job: CronJob, { now = false }: { now?: boolean } = {}): SiteCronJob {
  return {
    name: job.name,
    everyMinutes: cronEveryMinutes(job.schedule),
    timeoutMs: cronTimeoutMs(job.schedule),
    holdOnTimeout: true,
    run: async (_signal, { startedAt }) => {
      const runId = cronRunId(job.name, startedAt);
      try {
        const db = getDb(env);
        const [config] = await db
          .select()
          .from(cronConfig)
          .where(eq(cronConfig.cronName, job.name))
          .limit(1);
        if (!isCronEnabled(config ?? null)) return { outcome: "skipped", reason: "disabled" };
        const [last] = await db
          .select({ okAt: cronRuns.lastOkAt, failedAt: cronRuns.lastFailedAt })
          .from(cronRuns)
          .where(eq(cronRuns.name, job.name))
          .limit(1);
        const lastFinish = Math.max(last?.okAt ?? 0, last?.failedAt ?? 0);
        if (
          !now &&
          !isDueByInterval(
            lastFinish ? new Date(lastFinish) : null,
            config?.minIntervalMinutes ?? null,
            new Date(startedAt),
          )
        )
          return { outcome: "skipped", reason: "not_due" };
        const lock = env.CRON_LOCK.get(env.CRON_LOCK.idFromName(job.name));
        const token = await lock.acquire(CRON_LOCK_LEASE_MS);
        if (token === null) return { outcome: "skipped", reason: "locked" };
        try {
          return { outcome: "ok", reason: reasonOf(await job.handler(env, { runId })) };
        } finally {
          try {
            await lock.release(token);
          } catch {
            // Deliberately swallowed: see THE TOKEN IS THE FENCE above.
          }
        }
      } catch (err) {
        await alertCronFailure(
          env,
          getDb(env),
          {
            cronName: job.name,
            runId,
            error: err instanceof Error ? err.message : String(err),
            // Recova's alert carries the stack's first 500 characters (E26).
            stack: err instanceof Error ? (err.stack ?? null) : null,
          },
          new Date(),
        );
        throw err;
      }
    },
  };
}

/** A schedule's jobs in turn, each behind its gates, through runJobs: each run that executes is in cron_runs and
 *  cron_run_log, and after the last one Error names the failed ones, so Cloudflare marks the invocation failed. */
export async function runScheduledJobs(env: Env, jobs: CronJob[]): Promise<void> {
  await runJobs(
    () => env.DB,
    jobs.map((job) => gatedJob(env, job)),
    { history: CRON_HISTORY },
  );
}

/** The jobs the operator API's run_job may run now (RUN_NOW_JOBS in registry.ts), behind the enabled gate and the
 *  lock but not the interval, recorded as the trigger records them. */
export function runJobNowList(env: Env, jobs: (CronJob & { backup?: boolean })[]): SiteCronJob[] {
  return jobs.map((job) => ({
    ...gatedJob(env, job, { now: true }),
    ...(job.backup ? { backup: true } : {}),
  }));
}
