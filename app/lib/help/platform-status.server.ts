import { desc, eq, max } from "drizzle-orm";

import { cronRunHistory, type Db } from "~/db";

// /help's Platform status panel, ported from legacy app/(app)/help/page.tsx.
//
// Legacy reads a `cron_runs` table that keeps ONE ROW PER CRON carrying
// `last_succeeded_at` and `last_run_status`. Foxhound keeps `cron_run_history`,
// which is append-only, one row per RUN. So the two columns legacy selects are
// derived here rather than read: the newest successful run's finish time, and
// the status of the newest run whatever it was. Same two facts, same display
// rules, different storage shape (class (a) internals).

export type CronDisplayStatus = "ok" | "stale" | "error" | "pending";

export interface CronStatusRow {
  cronName: string;
  label: string;
  status: CronDisplayStatus;
  lastSucceededAt: Date | null;
}

/**
 * The crons that surface to a merchant, with legacy's own inclusion rule:
 * "Operator-only crons are intentionally hidden; platform health is the admin
 * team's responsibility, not the merchant's." So the retention sweeps,
 * cron-health, demo-reset and the billing job stay off this page exactly as
 * legacy keeps its own housekeeping off its own.
 *
 * THREE OF THESE ARE LEGACY'S, ONE IS NOT, AND THE SUBSTITUTION IS DELIBERATE.
 * Legacy shows process-recovery, process-winback, process-disputes and
 * expiring-cards. Foxhound has no dispute cron at all: dispute intake is
 * webhook-driven through the money DO (app/lib/webhooks/batches.ts
 * buildDisputeIntakeBatch), so there is no scheduled job whose health a
 * merchant could read, and rendering a "Dispute processing" row would name a
 * job that does not exist. `intelligence-ai` takes the fourth slot because it
 * is the remaining merchant-facing scheduled job: it is the nightly run that
 * produces the health scores and narrative the Intelligence pages show.
 */
export const VISIBLE_CRONS = [
  "recovery-tick",
  "winback-send",
  "expiring-cards",
  "intelligence-ai",
] as const;

export const CRON_LABELS: Record<string, string> = {
  "recovery-tick": "Recovery sequences",
  "winback-send": "Win-back sequences",
  "expiring-cards": "Expiring card alerts",
  "intelligence-ai": "Customer health scoring",
};

/**
 * Minutes of slack before a cron reads stale, legacy's per-cron map with
 * Foxhound's cadences in it.
 *
 * Legacy allows 90 minutes for its hourly `process-*` jobs and 1500 (25 hours)
 * for its daily one. recovery-tick and winback-send run every five minutes
 * here, so 90 minutes is eighteen missed ticks and is if anything more generous
 * than legacy's; expiring-cards and intelligence-ai are daily and take legacy's
 * daily allowance unchanged.
 */
const CRON_STALE_MINUTES: Record<string, number> = {
  "recovery-tick": 90,
  "winback-send": 90,
  "expiring-cards": 1500,
  "intelligence-ai": 1500,
};

const DEFAULT_STALE_MINUTES = 90;

/** Legacy's getCronStatus, with Foxhound's status vocabulary. Legacy compares
 *  against its own `'error'`; `cron_run_history.status` is written
 *  `success` / `failed` / `skipped` by app/lib/cron/run.ts. A cron with no run
 *  recorded at all is legacy's `pending_first_run`, expressed here as the
 *  absence of a row rather than as a sentinel string.
 *
 *  A `skipped` latest run (disabled, not due, locked) is deliberately NOT an
 *  error: it falls through to the age check, so a paused cron reads stale once
 *  it actually is, rather than reading as a failure the moment it is paused. */
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

/**
 * One row per visible cron, in the order VISIBLE_CRONS declares, whatever the
 * database returns. Legacy synthesizes a placeholder for any cron that has
 * never recorded a run "so the table is always four rows"; the same guarantee
 * holds here because the list is the spec and the query only decorates it.
 */
export async function getVisibleCronStatus(db: Db, nowMs: number): Promise<CronStatusRow[]> {
  const [succeeded, latest] = await Promise.all([
    db
      .select({ cronName: cronRunHistory.cronName, lastSucceededAt: max(cronRunHistory.finishedAt) })
      .from(cronRunHistory)
      .where(eq(cronRunHistory.status, "success"))
      .groupBy(cronRunHistory.cronName),
    Promise.all(
      VISIBLE_CRONS.map((cronName) =>
        db
          .select({ status: cronRunHistory.status })
          .from(cronRunHistory)
          .where(eq(cronRunHistory.cronName, cronName))
          .orderBy(desc(cronRunHistory.finishedAt))
          .limit(1)
          .then((rows) => ({ cronName, status: rows[0]?.status ?? null })),
      ),
    ),
  ]);

  const succeededByName = new Map(
    succeeded.map((r) => [r.cronName, r.lastSucceededAt === null ? null : new Date(r.lastSucceededAt)]),
  );
  const statusByName = new Map(latest.map((r) => [r.cronName, r.status]));

  return VISIBLE_CRONS.map((cronName) => {
    const lastSucceededAt = succeededByName.get(cronName) ?? null;
    const lastRunStatus = statusByName.get(cronName) ?? null;
    return {
      cronName,
      label: CRON_LABELS[cronName] ?? cronName,
      status: cronDisplayStatus(lastRunStatus, lastSucceededAt, nowMs, cronName),
      lastSucceededAt,
    };
  });
}
