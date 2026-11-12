import { inArray } from "drizzle-orm";

import { cronRuns, type Db } from "~/db";

// /help's Platform status panel, ported from legacy app/(app)/help/page.tsx.
//
// Legacy reads a `cron_runs` table that keeps ONE ROW PER CRON carrying
// `last_succeeded_at` and `last_run_status`. Foxhound's `cron_runs` is
// site-runtime's, the same shape: `last_ok_at` is the last success, and the
// newest of `last_ok_at` and `last_failed_at` says whether the last run failed.

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
const VISIBLE_CRONS = [
  "recovery-tick",
  "winback-send",
  "expiring-cards",
  "intelligence-ai",
] as const;

const CRON_LABELS: Record<string, string> = {
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

/** Legacy's getCronStatus, with Foxhound's status vocabulary: `failed` is
 *  legacy's `'error'`. A cron with no run recorded at all is legacy's
 *  `pending_first_run`, expressed here as the absence of a row rather than as a
 *  sentinel string. A skipped run (disabled, not due, locked) records nothing,
 *  so a paused cron reads stale once it actually is, rather than reading as a
 *  failure the moment it is paused. */
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
