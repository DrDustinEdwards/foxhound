-- site-api v0.21.0's store table: SITE_API_STORE_SQL_V0_21 from
-- @dustinedwards/site-api/store, verbatim, read and written only by the
-- package's d1SiteApiStore (app/lib/carrel/handler.server.ts). The media file
-- each upload's duplicates key became, so a picture the adapter converted or
-- shrank is still found when it is sent again. Not in the Drizzle schema on
-- purpose, as 0064: the package owns its SQL. Additive, empty.
CREATE TABLE IF NOT EXISTS media_uploads (
  sha256 TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  at TEXT NOT NULL
);
