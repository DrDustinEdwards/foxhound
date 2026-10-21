// /admin/platform/crons data layer: cron_config enable/disable + cron_run_history.
// Not money-adjacent (this toggles operational scheduling, not billing), so
// this is Pass 1 scope; still audit-logged since it's a real operator action
// that changes production behavior.

import { and, desc, eq, gte, max, or } from "drizzle-orm";

import type { Db } from "~/db";
import { CRON_JOBS } from "~/lib/cron/registry";
import { cronConfig, cronRunHistory } from "~/db";
import { DAY_MS } from "~/lib/constants";

export interface CronRow {
  name: string;
  schedule: string;
  enabled: boolean;
  /** False when the cron has no cron_config row, so it is on by default and
   *  has never been switched here (Recova's "no config row" note). */
  configured: boolean;
  minIntervalMinutes: number | null;
  lastRun: {
    id: string;
    status: string;
    finishedAt: Date;
    rowsProcessed: number | null;
    message: string | null;
  } | null;
  /** When this cron's newest successful run finished; null when it has none
   *  (Recova's "Last succeeded" column). */
  lastSucceededAt: Date | null;
  /** This cron's failed runs in the last 24 hours, newest first: the runs the
   *  Overview's cron health counts and links to. */
  recentFailures: Array<{ id: string; finishedAt: Date; message: string | null }>;
}

const FAILURE_WINDOW_MS = DAY_MS;
const PAIRS_PER_READ = 30;

/** One row per registered job (app/lib/cron/registry.ts is the source of
 *  truth for what jobs exist; cron_config only overrides enabled/interval - a
 *  missing config row means enabled, per app/lib/cron/gating.ts).
 *
 *  Each cron's own newest run, not the newest 500 runs overall. The recovery
 *  tick and the win-back send write a row every five minutes, 576 a day
 *  between them, so a daily job that ran 21 hours ago fell outside a shared
 *  window and the page said it had never run; a monthly job always did. Four
 *  reads for today's registry, whatever the history's size: the config, the
 *  newest finish per cron and status, those newest rows, and the last day's
 *  failures. */
export async function listCronRows(db: Db, now: number = Date.now()): Promise<CronRow[]> {
  const [configRows, newest, failures] = await Promise.all([
    db.select().from(cronConfig),
    db
      .select({
        cronName: cronRunHistory.cronName,
        status: cronRunHistory.status,
        finishedAt: max(cronRunHistory.finishedAt),
      })
      .from(cronRunHistory)
      .groupBy(cronRunHistory.cronName, cronRunHistory.status),
    db
      .select({
        id: cronRunHistory.id,
        cronName: cronRunHistory.cronName,
        finishedAt: cronRunHistory.finishedAt,
        message: cronRunHistory.message,
      })
      .from(cronRunHistory)
      .where(and(eq(cronRunHistory.status, "failed"), gte(cronRunHistory.finishedAt, new Date(now - FAILURE_WINDOW_MS))))
      .orderBy(desc(cronRunHistory.finishedAt)),
  ]);

  const configByName = new Map(configRows.map((c) => [c.cronName, c]));

  // The newest finish of any status, and of a success, per cron.
  const lastFinishByName = new Map<string, { status: string; at: Date }>();
  const lastSuccessByName = new Map<string, Date>();
  for (const n of newest) {
    if (!n.finishedAt) continue;
    const at = n.finishedAt;
    const seen = lastFinishByName.get(n.cronName);
    if (!seen || at.getTime() > seen.at.getTime()) lastFinishByName.set(n.cronName, { status: n.status, at });
    if (n.status === "success") lastSuccessByName.set(n.cronName, at);
  }

  // The rows behind those newest finishes, for their status and message. Only
  // registered crons (a retired name's history is not shown), and in chunks:
  // each one binds three parameters and D1 takes at most 100 in one statement.
  // Naming the status lets each read seek the (cron_name, status, finished_at)
  // index on all three columns.
  const registered = new Set(CRON_JOBS.map((j) => j.name));
  const pairs = [...lastFinishByName].filter(([name]) => registered.has(name));
  const lastRunByName = new Map<string, typeof cronRunHistory.$inferSelect>();
  const chunks: Array<typeof pairs> = [];
  for (let i = 0; i < pairs.length; i += PAIRS_PER_READ) chunks.push(pairs.slice(i, i + PAIRS_PER_READ));
  const lastRuns = (
    await Promise.all(
      chunks.map((chunk) =>
        db
          .select()
          .from(cronRunHistory)
          .where(
            or(
              ...chunk.map(([name, { status, at }]) =>
                and(eq(cronRunHistory.cronName, name), eq(cronRunHistory.status, status), eq(cronRunHistory.finishedAt, at)),
              ),
            ),
          ),
      ),
    )
  ).flat();
  for (const run of lastRuns) {
    // Two runs finishing in the same millisecond: either is the last run.
    if (!lastRunByName.has(run.cronName)) lastRunByName.set(run.cronName, run);
  }

  const failuresByName = new Map<string, CronRow["recentFailures"]>();
  for (const run of failures) {
    const list = failuresByName.get(run.cronName) ?? [];
    list.push({ id: run.id, finishedAt: run.finishedAt, message: run.message });
    failuresByName.set(run.cronName, list);
  }

  return CRON_JOBS.map((job) => {
    const config = configByName.get(job.name);
    const lastRun = lastRunByName.get(job.name);
    return {
      name: job.name,
      schedule: job.schedule,
      enabled: config?.enabled ?? true,
      configured: config !== undefined,
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
      lastSucceededAt: lastSuccessByName.get(job.name) ?? null,
      recentFailures: failuresByName.get(job.name) ?? [],
    };
  });
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
