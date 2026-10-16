import { desc, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { cronConfig, cronRunHistory, getDb } from "~/db";
import { CRON_LOCK_LEASE_MS } from "~/lib/constants";

import { alertCronFailure, type AlertOutcome } from "./alerts.server";
import { isCronEnabled, isDueByInterval } from "./gating";

// The cron runner: the single wrapper every scheduled job goes through. It
// enforces the three gates in order (config-enabled -> min-interval -> per-cron DO
// lock), runs the handler, and records the run in cron_run_history. History writes
// are operational (not money), so a plain insert via getDb, not the money DO.
//
// A job's own logic never touches cron_config or the lock; it just does work and
// reports how many rows it processed.

export interface CronJobResult {
  rowsProcessed: number;
  message?: string;
}
/** What a handler learns about the run it is executing inside (313). Optional
 *  so the twelve handlers that do not send email are untouched: only the paths
 *  that WRITE an email_sends row need to attribute it. */
export interface CronRunContext {
  runId: string;
}
export type CronHandler = (env: Env, ctx?: CronRunContext) => Promise<CronJobResult>;

export type CronRunStatus = "success" | "failed" | "skipped";
export interface CronRunOutcome {
  cronName: string;
  status: CronRunStatus;
  rowsProcessed: number;
  message?: string;
  /** The cron_run_history id, on runs that executed (313). Absent on skips,
   *  which write no history row. */
  runId?: string;
  /** What the failure alert did, on failed runs (313). Carried rather than
   *  thrown: the alert path is fail-open by design, so its outcome is data. */
  alert?: AlertOutcome;
}

/** The cron_run_history insert for one executed run. Operational, not a money write. */
export function buildCronRunInsert(
  db: Db,
  input: {
    /** Minted by the CALLER (313) rather than defaulted by the schema, so the
     *  run can be named in a failure alert. A row whose id nothing knows cannot
     *  be referenced by the thing that reports on it. */
    id: string;
    cronName: string;
    startedAt: Date;
    finishedAt: Date;
    status: Exclude<CronRunStatus, "skipped">;
    rowsProcessed: number;
    message: string | null;
  },
) {
  return db.insert(cronRunHistory).values({
    id: input.id,
    cronName: input.cronName,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    rowsProcessed: input.rowsProcessed,
    message: input.message,
    createdAt: input.finishedAt,
  });
}

async function recordRun(
  env: Env,
  runId: string,
  cronName: string,
  startedAt: Date,
  status: Exclude<CronRunStatus, "skipped">,
  rowsProcessed: number,
  message: string | null,
): Promise<void> {
  await buildCronRunInsert(getDb(env), {
    id: runId,
    cronName,
    startedAt,
    finishedAt: new Date(),
    status,
    rowsProcessed,
    message,
  });
}

/** Run one scheduled job through the config + interval + lock gates, logging the
 *  result to cron_run_history. A skipped run (disabled / not due / locked) writes
 *  no history row; a run that executes writes exactly one. */
export async function runCronJob(
  env: Env,
  cronName: string,
  handler: CronHandler,
): Promise<CronRunOutcome> {
  try {
    return await executeCronJob(env, cronName, handler);
  } catch (err) {
    // THE INFRASTRUCTURE GUARD (376 item 15's verify-first list, session 85).
    //
    // WHAT WAS WRONG. The try/catch inside `executeCronJob` wraps the HANDLER
    // and nothing else. Everything before it (the config read, the interval
    // read, acquiring the lock) and the history write after it run unguarded, so
    // a D1 blip or a Durable Object hiccup did not fail this job, it threw out
    // of `runCronJob` entirely. `scheduled()` iterates the jobs for a schedule
    // with no guard of its own, so that one throw skipped EVERY REMAINING JOB on
    // that schedule, silently: no history row, no alert, nothing to read
    // afterwards saying they had not run. On the daily schedule that is seven
    // jobs behind the first one to trip, including four retention sweeps.
    //
    // ONE AUTHORITY, HERE. `runCronJob` is now total: it either returns an
    // outcome or returns a failed outcome, and never throws. The loop in
    // `scheduled()` is therefore safe without a second try/catch of its own,
    // which would be two guards for one rule (381 binding e).
    const message = err instanceof Error ? err.message : "cron infrastructure error";
    return {
      cronName,
      status: "failed",
      rowsProcessed: 0,
      message,
      ...(await recordInfrastructureFailure(env, cronName, message)),
    };
  }
}

/**
 * Best-effort record of a failure that happened OUTSIDE the handler.
 *
 * BEST-EFFORT IS THE HONEST WORD, and the limit is worth stating rather than
 * implying: the commonest cause of an infrastructure throw here is D1 being
 * unreachable, and D1 is also what a history row is written to. When that is the
 * failure, there is nowhere to record it and the outcome is returned to the
 * caller without a row. What this DOES buy is every other case: a Durable Object
 * hiccup, a lock RPC failure, a bad binding, all of which leave D1 fine and are
 * recorded normally.
 *
 * It never throws, or it would defeat the guard that calls it.
 */
async function recordInfrastructureFailure(
  env: Env,
  cronName: string,
  message: string,
): Promise<{ runId?: string; alert?: AlertOutcome }> {
  const runId = crypto.randomUUID();
  try {
    await recordRun(env, runId, cronName, new Date(), "failed", 0, message);
  } catch {
    // Nothing to do and nowhere to say it: see above.
    return {};
  }
  try {
    // The same alert a handler failure raises (313). An infrastructure failure
    // that recorded a row and told nobody would be exactly the silence 313 was
    // built to end.
    const alert = await alertCronFailure(env, getDb(env), { cronName, runId, error: message }, new Date());
    return { runId, alert };
  } catch {
    return { runId };
  }
}

async function executeCronJob(
  env: Env,
  cronName: string,
  handler: CronHandler,
): Promise<CronRunOutcome> {
  const db = getDb(env);

  const cfg = (
    await db.select().from(cronConfig).where(eq(cronConfig.cronName, cronName)).limit(1)
  )[0];
  const config = cfg
    ? { enabled: cfg.enabled, minIntervalMinutes: cfg.minIntervalMinutes }
    : null;

  if (!isCronEnabled(config)) {
    return { cronName, status: "skipped", rowsProcessed: 0, message: "disabled" };
  }

  const last = (
    await db
      .select({ finishedAt: cronRunHistory.finishedAt })
      .from(cronRunHistory)
      .where(eq(cronRunHistory.cronName, cronName))
      .orderBy(desc(cronRunHistory.finishedAt))
      .limit(1)
  )[0];
  if (!isDueByInterval(last?.finishedAt ?? null, config?.minIntervalMinutes ?? null, new Date())) {
    return { cronName, status: "skipped", rowsProcessed: 0, message: "not_due" };
  }

  const lockNs = env.CRON_LOCK;
  const lock = lockNs.get(lockNs.idFromName(cronName));
  // THE TOKEN IS THE FENCE (376 item 14). `acquire` hands back the holder's
  // token, and the `finally` below hands that same token to `release`, so this
  // run can only ever free ITS OWN lease. An overrunning run whose lease has
  // already lapsed releases nothing, rather than freeing the lease of the run
  // that replaced it.
  const lockToken = await lock.acquire(CRON_LOCK_LEASE_MS);
  if (lockToken === null) {
    return { cronName, status: "skipped", rowsProcessed: 0, message: "locked" };
  }

  const startedAt = new Date();
  const runId = crypto.randomUUID();
  try {
    const result = await handler(env, { runId });
    await recordRun(env, runId, cronName, startedAt, "success", result.rowsProcessed, result.message ?? null);
    return { cronName, status: "success", rowsProcessed: result.rowsProcessed, message: result.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : "cron error";
    await recordRun(env, runId, cronName, startedAt, "failed", 0, message);
    // THE ALERT (313). Deliberately AFTER the history write, so the run is on the
    // record even if alerting is broken, and deliberately FAIL-OPEN: alertCronFailure
    // never throws, and its outcome is carried on the result rather than raised.
    // An observability tool that can fail a money job is worse than none.
    // The stack goes with it: Recova's alert carries its first 500 characters (E26).
    const stack = err instanceof Error ? (err.stack ?? null) : null;
    const alert = await alertCronFailure(
      env,
      getDb(env),
      { cronName, runId, error: message, stack },
      new Date(),
    );
    return { cronName, status: "failed", rowsProcessed: 0, message, runId, alert };
  } finally {
    // A FAILED RELEASE MUST NOT REWRITE THE RUN'S OUTCOME. A throw from here
    // would replace the return value above, so a successful run whose lock
    // release failed would be reported as a failure, contradicting the history
    // row that already says success. The lease is the backstop: an unreleased
    // lock lapses on its own, which is the whole reason it is a lease.
    try {
      await lock.release(lockToken);
    } catch {
      // Deliberately swallowed. See above.
    }
  }
}
