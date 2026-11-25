// /admin/platform/crons data layer: cron_config enable/disable, with each job's last run from cron_runs and cron_run_log (site-runtime's, written by runJobs).
// Not money-adjacent, but audit-logged: it is an operator action that changes production behavior.

import { and, desc, eq, gte, inArray, max, ne } from "drizzle-orm";

import type { Db } from "~/db";
import { CRON_JOBS } from "~/lib/cron/registry";
import { cronConfig, cronRunLog, cronRuns } from "~/db";
import { cronRunId } from "~/lib/admin/crons";
import { DAY_MS } from "~/lib/constants";

export interface CronRow {
  name: string;
  schedule: string;
  enabled: boolean;
  configured: boolean;
  minIntervalMinutes: number | null;
  lastRun: {
    id: string;
    /** cron_run_log's outcome: ok, refused or failed. */
    status: string;
    finishedAt: Date;
    message: string | null;
  } | null;
  lastSucceededAt: Date | null;
  /** This cron's failed runs in the last 24 hours, newest first: the runs the Overview's cron health counts and links to. */
  recentFailures: Array<{ id: string; finishedAt: Date; message: string | null }>;
}

/**
 * The runs that failed (or were refused) since `sinceMs`, newest first, every
 * job's: the Overview's cron health and the Crons page's failures. An empty
 * reason is null, so the page says none was recorded.
 */
export async function failedCronRuns(
  db: Db,
  sinceMs: number,
): Promise<Array<{ id: string; cronName: string; finishedAt: Date; message: string | null }>> {
  const rows = await db
    .select()
    .from(cronRunLog)
    .where(and(ne(cronRunLog.outcome, "ok"), gte(cronRunLog.finishedAt, sinceMs)))
    .orderBy(desc(cronRunLog.id));
  return rows.map((run) => ({
    id: cronRunId(run.name, run.startedAt),
    cronName: run.name,
    finishedAt: new Date(run.finishedAt),
    message: run.reason || null,
  }));
}

/**
 * One row per registered job (app/lib/cron/registry.ts is the source of truth; cron_config only overrides enabled/interval, and a missing row means enabled, per gating.ts). Four reads whatever the log's size: the config, each job's newest run, its last success from cron_runs (which keeps it however long ago it was), and the last day's failures.
 */
export async function listCronRows(db: Db, now: number = Date.now()): Promise<CronRow[]> {
  const [configRows, newest, runRows, failures] = await Promise.all([
    db.select().from(cronConfig),
    db
      .select()
      .from(cronRunLog)
      .where(
        inArray(
          cronRunLog.id,
          db
            .select({ id: max(cronRunLog.id) })
            .from(cronRunLog)
            .groupBy(cronRunLog.name),
        ),
      ),
    db.select({ name: cronRuns.name, okAt: cronRuns.lastOkAt }).from(cronRuns),
    failedCronRuns(db, now - DAY_MS),
  ]);

  const configByName = new Map(configRows.map((c) => [c.cronName, c]));
  const newestByName = new Map(newest.map((r) => [r.name, r]));
  const okAtByName = new Map(runRows.map((r) => [r.name, r.okAt]));
  const failuresByName = new Map<string, CronRow["recentFailures"]>();
  for (const { cronName, ...run } of failures) {
    failuresByName.set(cronName, [...(failuresByName.get(cronName) ?? []), run]);
  }

  return CRON_JOBS.map((job) => {
    const config = configByName.get(job.name);
    const last = newestByName.get(job.name);
    const okAt = okAtByName.get(job.name);
    return {
      name: job.name,
      schedule: job.schedule,
      enabled: config?.enabled ?? true,
      configured: config !== undefined,
      minIntervalMinutes: config?.minIntervalMinutes ?? null,
      lastRun: last
        ? {
            id: cronRunId(job.name, last.startedAt),
            status: last.outcome,
            finishedAt: new Date(last.finishedAt),
            message: last.reason || null,
          }
        : null,
      lastSucceededAt: okAt == null ? null : new Date(okAt),
      recentFailures: failuresByName.get(job.name) ?? [],
    };
  });
}

export function isKnownCronName(cronName: string): boolean {
  return CRON_JOBS.some((job) => job.name === cronName);
}

/** Upsert by hand: cron_config's primary key is the name itself, so select-then-insert-or-update reads clearer for a low-frequency admin action. Not a money write: plain db call, no DO. */
export async function setCronEnabled(db: Db, cronName: string, enabled: boolean): Promise<void> {
  if (!isKnownCronName(cronName)) {
    throw new Error(`unknown cron name: ${cronName}`);
  }
  const existing = await db
    .select()
    .from(cronConfig)
    .where(eq(cronConfig.cronName, cronName))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(cronConfig)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(cronConfig.cronName, cronName));
  } else {
    await db.insert(cronConfig).values({ cronName, enabled, updatedAt: new Date() });
  }
}
