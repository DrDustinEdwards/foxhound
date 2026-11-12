import type Database from "better-sqlite3";

import type { CronHandler } from "~/lib/cron/run";

// One job through the real runner (app/lib/cron/run.ts: its gates, then site-runtime's runJobs), for a test whose
// getDb is the in-memory database and whose env.DB is d1Over the same SQLite, so runJobs' cron_runs and cron_run_log
// writes land where the test reads them.

/** Runs `handler` as job `name` on `schedule` (daily by default). A failed run is in the log, not thrown. */
export async function runJob(
  env: Env,
  name: string,
  handler: CronHandler,
  schedule = "0 3 * * *",
): Promise<void> {
  const { runScheduledJobs } = await import("~/lib/cron/run");
  await runScheduledJobs(env, [{ name, schedule, handler }]).catch(() => undefined);
}

/** The runs runJobs kept for `name` in cron_run_log, oldest first. */
export function loggedRuns(
  sqlite: Database.Database,
  name: string,
): Array<{ outcome: string; reason: string; started_at: number }> {
  return sqlite
    .prepare("select outcome, reason, started_at from cron_run_log where name = ? order by id")
    .all(name) as Array<{ outcome: string; reason: string; started_at: number }>;
}
