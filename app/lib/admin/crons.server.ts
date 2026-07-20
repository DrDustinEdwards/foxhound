// /admin/crons data layer: cron_config enable/disable + cron_run_history.
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
    status: string;
    finishedAt: Date;
    rowsProcessed: number | null;
    message: string | null;
  } | null;
}

/** One row per registered job (app/lib/cron/registry.ts is the source of
 *  truth for what jobs exist; cron_config only overrides enabled/interval - a
 *  missing config row means enabled, per app/lib/cron/gating.ts). */
export async function listCronRows(db: Db): Promise<CronRow[]> {
  const [configRows, lastRuns] = await Promise.all([
    db.select().from(cronConfig),
    db.select().from(cronRunHistory).orderBy(desc(cronRunHistory.finishedAt)).limit(500),
  ]);
  const configByName = new Map(configRows.map((c) => [c.cronName, c]));
  const lastRunByName = new Map<string, (typeof lastRuns)[number]>();
  for (const run of lastRuns) {
    if (!lastRunByName.has(run.cronName)) lastRunByName.set(run.cronName, run);
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
            status: lastRun.status,
            finishedAt: lastRun.finishedAt,
            rowsProcessed: lastRun.rowsProcessed,
            message: lastRun.message,
          }
        : null,
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

/** Upsert-by-hand (D1 supports ON CONFLICT via drizzle's onConflictDoUpdate,
 *  but cron_config's primary key is the name itself, so a plain
 *  select-then-insert-or-update reads clearer here for a low-frequency admin
 *  action). Not a money write: plain db call, no DO (mirrors gotcha #25's
 *  operational-write precedent). */
export async function setCronEnabled(db: Db, cronName: string, enabled: boolean): Promise<void> {
  const existing = await db.select().from(cronConfig).where(eq(cronConfig.cronName, cronName)).limit(1);
  if (existing.length > 0) {
    await db.update(cronConfig).set({ enabled, updatedAt: new Date() }).where(eq(cronConfig.cronName, cronName));
  } else {
    await db.insert(cronConfig).values({ cronName, enabled, updatedAt: new Date() });
  }
}
