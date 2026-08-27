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
    const alert = await alertCronFailure(
      env,
      getDb(env),
      { cronName, runId, error: message },
      new Date(),
    );
    return { cronName, status: "failed", rowsProcessed: 0, message, runId, alert };
  } finally {
    await lock.release(lockToken);
  }
}
