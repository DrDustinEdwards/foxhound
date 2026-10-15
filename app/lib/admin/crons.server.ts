// /admin/platform/crons data layer: cron_config enable/disable + cron_run_history.
// Not money-adjacent (this toggles operational scheduling, not billing), so
// this is Pass 1 scope; still audit-logged since it's a real operator action
// that changes production behavior.

import { desc, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { CRON_JOBS } from "~/lib/cron/registry";
import { cronConfig, cronRunHistory } from "~/db";

export interface CronRow {
  name: string;
  schedule: string;
  enabled: boolean;
  minIntervalMinutes: number | null;
  lastRun: {
    id: string;
    status: string;
    finishedAt: Date;
    rowsProcessed: number | null;
    message: string | null;
  } | null;
  /** This cron's failed runs in the last 24 hours, newest first: the runs the
   *  Overview's cron health counts and links to. */
  recentFailures: Array<{ id: string; finishedAt: Date; message: string | null }>;
}

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One row per registered job (app/lib/cron/registry.ts is the source of
 *  truth for what jobs exist; cron_config only overrides enabled/interval - a
 *  missing config row means enabled, per app/lib/cron/gating.ts). */
export async function listCronRows(db: Db, now: number = Date.now()): Promise<CronRow[]> {
  const [configRows, lastRuns] = await Promise.all([
    db.select().from(cronConfig),
    db.select().from(cronRunHistory).orderBy(desc(cronRunHistory.finishedAt)).limit(500),
  ]);
  const configByName = new Map(configRows.map((c) => [c.cronName, c]));
  const lastRunByName = new Map<string, (typeof lastRuns)[number]>();
  const failuresByName = new Map<string, CronRow["recentFailures"]>();
  for (const run of lastRuns) {
    if (!lastRunByName.has(run.cronName)) lastRunByName.set(run.cronName, run);
    if (run.status === "failed" && now - run.finishedAt.getTime() <= FAILURE_WINDOW_MS) {
      const list = failuresByName.get(run.cronName) ?? [];
      list.push({ id: run.id, finishedAt: run.finishedAt, message: run.message });
      failuresByName.set(run.cronName, list);
    }
  }

  return CRON_JOBS.map((job) => {
    const config = configByName.get(job.name);
    const lastRun = lastRunByName.get(job.name);
    return {
      name: job.name,
      schedule: job.schedule,
      enabled: config?.enabled ?? true,
      minIntervalMinutes: config?.minIntervalMinutes ?? null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            finishedAt: lastRun.finishedAt,
            rowsProcessed: lastRun.rowsProcessed,
            message: lastRun.message,
          }
        : null,
      recentFailures: failuresByName.get(job.name) ?? [],
    };
  });
}

export async function getRunHistory(db: Db, cronName: string, limit = 20) {
  return db
    .select()
    .from(cronRunHistory)
    .where(eq(cronRunHistory.cronName, cronName))
    .orderBy(desc(cronRunHistory.finishedAt))
    .limit(limit);
}

/** True when `cronName` is a job the registry actually dispatches. */
export function isKnownCronName(cronName: string): boolean {
  return CRON_JOBS.some((job) => job.name === cronName);
}

/**
 * Upsert-by-hand (D1 supports ON CONFLICT via drizzle's onConflictDoUpdate,
 * but cron_config's primary key is the name itself, so a plain
 * select-then-insert-or-update reads clearer here for a low-frequency admin
 * action). Not a money write: plain db call, no DO (mirrors gotcha #25's
 * operational-write precedent).
 *
 * The name is validated against the registry because an unknown name used to be
 * written happily, and a missing cron_config row means ENABLED (see
 * app/lib/cron/gating.ts). Together those turned a typo into a silent failure of
 * the worst kind: the operator got a success response, the row existed and looked
 * disabled on inspection, it gated nothing, and the real job kept running. An
 * admin who believes they stopped a cron has to be right about that.
 *
 * Throws rather than no-oping so no caller can treat a rejected write as applied.
 */
export async function setCronEnabled(db: Db, cronName: string, enabled: boolean): Promise<void> {
  if (!isKnownCronName(cronName)) {
    throw new Error(`unknown cron name: ${cronName}`);
  }
  const existing = await db.select().from(cronConfig).where(eq(cronConfig.cronName, cronName)).limit(1);
  if (existing.length > 0) {
    await db.update(cronConfig).set({ enabled, updatedAt: new Date() }).where(eq(cronConfig.cronName, cronName));
  } else {
    await db.insert(cronConfig).values({ cronName, enabled, updatedAt: new Date() });
  }
}
