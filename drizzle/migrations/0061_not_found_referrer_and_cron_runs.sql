-- site-runtime v0.42.0's two tables, as its README asks: NOT_FOUND_UPGRADE_SQL
-- (./not-found) adds the referring host and the kind to page_404_daily and moves
-- its unique key to (day, path, referrer_host), which the new upsert needs, and
-- CRON_SQL (./cron) adds cron_runs, which runJobs writes and /health's cronCheck
-- reads. The statements are the package's own, in Drizzle's breakpoints; the
-- snapshot is drizzle-kit's for app/db/schema/platform.ts. ADDITIVE: no table is
-- recreated and no money table is touched (CLAUDE.md hard rule 5 does not apply).
ALTER TABLE page_404_daily ADD COLUMN referrer_host TEXT NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE page_404_daily ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';--> statement-breakpoint
DROP INDEX IF EXISTS page_404_daily_day_path_uq;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS page_404_daily_day_path_referrer_uq ON page_404_daily (day, path, referrer_host);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cron_runs (
  name TEXT PRIMARY KEY NOT NULL,
  every_minutes INTEGER NOT NULL,
  first_started_at INTEGER,
  last_started_at INTEGER,
  last_ok_at INTEGER,
  last_failed_at INTEGER,
  last_error TEXT
);
