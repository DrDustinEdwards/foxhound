-- site-api v0.17.0's own store: SITE_API_STORE_SQL from
-- @dustinedwards/site-api/store, verbatim, read and written only by the
-- package's d1SiteApiStore (app/lib/carrel/handler.server.ts). Each Carrel
-- write's answer under its change id for 7 days, so a retry answers the same
-- and runs nothing (site_api_writes); the publish hooks that failed, for the
-- cron to run again (hook_retries); only the SHA-256 of each preview link's
-- token (preview_links); and the pages each post last sent webmentions to
-- (webmention_targets). Not in the Drizzle schema on purpose, as 0056: the
-- package owns its SQL, and nothing in Foxhound queries it.
CREATE TABLE IF NOT EXISTS site_api_writes (
  change_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS site_api_writes_at ON site_api_writes (at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hook_retries (
  id TEXT PRIMARY KEY,
  hook TEXT NOT NULL,
  event TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_at TEXT NOT NULL,
  last_error TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hook_retries_due ON hook_retries (next_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS preview_links (
  token_hash TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  change_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS preview_links_content ON preview_links (content_id, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webmention_targets (
  source TEXT PRIMARY KEY,
  targets TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
