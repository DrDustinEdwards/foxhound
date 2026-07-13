// Pure cron gating (cron_config + min-interval). Kept separate from the runner so
// the decisions are unit-testable without a DB or a Durable Object.

export interface CronConfigRow {
  enabled: boolean;
  minIntervalMinutes: number | null;
}

/** A job runs unless cron_config explicitly disables it. A missing row = enabled
 *  (a job is on by default; admin opts OUT). */
export function isCronEnabled(config: CronConfigRow | null): boolean {
  return config?.enabled ?? true;
}

/** True when enough time has passed since the last successful/failed run. No
 *  configured interval, or no prior run, means always due. */
export function isDueByInterval(
  lastFinishedAt: Date | null,
  minIntervalMinutes: number | null,
  now: Date,
): boolean {
  if (!minIntervalMinutes || !lastFinishedAt) return true;
  return now.getTime() - lastFinishedAt.getTime() >= minIntervalMinutes * 60 * 1000;
}
