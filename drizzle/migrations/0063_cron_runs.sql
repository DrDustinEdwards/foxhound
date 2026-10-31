-- site-runtime ./cron's CRON_SQL, as its README asks: cron_runs, which runJobs
-- writes and /health's cronCheck reads. The statement is the package's own; the
-- snapshot is drizzle-kit's for app/db/schema/platform.ts. NOT_FOUND_UPGRADE_SQL
-- is already migration 0061. ADDITIVE: one new table, no table is recreated and
-- no money table is touched (CLAUDE.md hard rule 5 does not apply).
CREATE TABLE IF NOT EXISTS cron_runs (
  name TEXT PRIMARY KEY NOT NULL,
  every_minutes INTEGER NOT NULL,
  first_started_at INTEGER,
  last_started_at INTEGER,
  last_ok_at INTEGER,
  last_failed_at INTEGER,
  last_error TEXT
);
