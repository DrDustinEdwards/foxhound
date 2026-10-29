-- Scheduled blog publishing (site-api v0.10.0). The table is site-api's
-- SCHEDULED_UPDATES_SQL from @dustinedwards/site-api/schedules, verbatim, so the
-- package's d1ScheduledUpdates store reads and writes it. One row per post: on a
-- draft it is the time the post first goes live; on a live post it is a pending
-- update that replaces the live version at that time. Not in the Drizzle schema
-- on purpose: the package owns its SQL, and nothing in Foxhound queries it.
CREATE TABLE IF NOT EXISTS scheduled_updates (
  content_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  change_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scheduled_updates_due ON scheduled_updates (publish_at);
