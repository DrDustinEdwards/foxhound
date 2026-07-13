import { desc, eq } from "drizzle-orm";

import { cronConfig, cronRunHistory, getDb } from "~/db";
import { CRON_LOCK_LEASE_MS } from "~/lib/constants";

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
export type CronHandler = (env: Env) => Promise<CronJobResult>;

export type CronRunStatus = "success" | "failed" | "skipped";
export interface CronRunOutcome {
  cronName: string;
  status: CronRunStatus;
  rowsProcessed: number;
  message?: string;
}

async function recordRun(
  env: Env,
  cronName: string,
  startedAt: Date,
  status: Exclude<CronRunStatus, "skipped">,
  rowsProcessed: number,
  message: string | null,
): Promise<void> {
  await getDb(env).insert(cronRunHistory).values({
    cronName,
    startedAt,
    finishedAt: new Date(),
    status,
    rowsProcessed,
    message,
    createdAt: new Date(),
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
  const acquired = await lock.acquire(CRON_LOCK_LEASE_MS);
  if (!acquired) {
    return { cronName, status: "skipped", rowsProcessed: 0, message: "locked" };
  }

  const startedAt = new Date();
  try {
    const result = await handler(env);
    await recordRun(env, cronName, startedAt, "success", result.rowsProcessed, result.message ?? null);
    return { cronName, status: "success", rowsProcessed: result.rowsProcessed, message: result.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : "cron error";
    await recordRun(env, cronName, startedAt, "failed", 0, message);
    return { cronName, status: "failed", rowsProcessed: 0, message };
  } finally {
    await lock.release();
  }
}
