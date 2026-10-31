-- site-runtime v0.51.0 auth event table: AUTH_EVENTS_SQL from
-- @dustinedwards/site-runtime/sign-in, verbatim, written by its sign-in
-- (eventsDb, app/lib/auth/auth.server.ts) and read by securityHistory on
-- /settings/account, authSpikeCheck on /health and pruneAuthEvents in the
-- daily cron. One row per auth event: the time, the event, the way in, the
-- user id, the device and a coarse place; never an address, token or code. Not
-- in the Drizzle schema on purpose, as 0056: the package owns its SQL, and
-- nothing in Foxhound queries it.
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  change TEXT,
  via TEXT,
  user_id TEXT,
  device TEXT,
  location TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_events_user ON auth_events (user_id, at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_events_at ON auth_events (at, event);
