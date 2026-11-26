import { inArray } from "drizzle-orm";

import { cronRuns, type Db } from "~/db";

// /help's Platform status panel. `cron_runs` (site-runtime's) keeps one row per cron: `last_ok_at` is the last
// success, and the newer of `last_ok_at` and `last_failed_at` says whether the last run failed.

export type CronDisplayStatus = "ok" | "stale" | "error" | "pending";

export interface CronStatusRow {
  cronName: string;
  label: string;
  status: CronDisplayStatus;
  lastSucceededAt: Date | null;
}

/** The crons that surface to a merchant. Operator-only crons (retention sweeps, cron-health, demo-reset,
 *  billing) stay hidden. There is no dispute cron (intake is webhook-driven via the money DO), so
 *  `intelligence`, the nightly run behind the Intelligence pages, takes that slot. */
const VISIBLE_CRONS = ["recovery-tick", "winback-send", "expiring-cards", "intelligence"] as const;

const CRON_LABELS: Record<string, string> = {
  "recovery-tick": "Recovery sequences",
  "winback-send": "Win-back sequences",
  "expiring-cards": "Expiring card alerts",
  intelligence: "Customer health scoring",
};

/** Minutes of slack before a cron reads stale: 90 for the five-minute recovery-tick and winback-send, 1500
 *  (25 hours) for the daily expiring-cards and intelligence. */
const CRON_STALE_MINUTES: Record<string, number> = {
  "recovery-tick": 90,
  "winback-send": 90,
  "expiring-cards": 1500,
  intelligence: 1500,
};

const DEFAULT_STALE_MINUTES = 90;

/** `failed` when the last run failed; no row at all is a cron that has not run yet. A skipped run (disabled,
 *  not due, locked) records nothing, so a paused cron reads stale once it is, not failed. */
export function cronDisplayStatus(
  lastRunStatus: string | null,
  lastSucceededAt: Date | null,
  nowMs: number,
  cronName: string,
): CronDisplayStatus {
  if (lastRunStatus === "failed") return "error";
  if (!lastSucceededAt) return "pending";
  const ageMinutes = (nowMs - lastSucceededAt.getTime()) / 60_000;
  const threshold = CRON_STALE_MINUTES[cronName] ?? DEFAULT_STALE_MINUTES;
  return ageMinutes > threshold ? "stale" : "ok";
}

/** One row per visible cron in VISIBLE_CRONS order, whatever the database returns. */
export async function getVisibleCronStatus(db: Db, nowMs: number): Promise<CronStatusRow[]> {
  const rows = await db
    .select({ name: cronRuns.name, okAt: cronRuns.lastOkAt, failedAt: cronRuns.lastFailedAt })
    .from(cronRuns)
    .where(inArray(cronRuns.name, [...VISIBLE_CRONS]));
  const byName = new Map(rows.map((r) => [r.name, r]));

  return VISIBLE_CRONS.map((cronName) => {
    const row = byName.get(cronName);
    const lastSucceededAt = row?.okAt == null ? null : new Date(row.okAt);
    const lastRunStatus =
      row?.failedAt != null && row.failedAt > (row.okAt ?? 0) ? "failed" : row ? "ok" : null;
    return {
      cronName,
      label: CRON_LABELS[cronName] ?? cronName,
      status: cronDisplayStatus(lastRunStatus, lastSucceededAt, nowMs, cronName),
      lastSucceededAt,
    };
  });
}
