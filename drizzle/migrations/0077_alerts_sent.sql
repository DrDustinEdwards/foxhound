-- site-runtime ./cron-alert's ALERTS_SQL (v0.133.0), as written: alerts_sent, one row per
-- alert sent, which alertOnce and cronAlert claim before the mail. The snapshot is
-- drizzle-kit's for app/db/schema/email.ts. ADDITIVE: one new table, EMPTY. The old
-- cron_alerts table is left as it is, read and written by nothing (a drop is a contract
-- migration); no money table is touched (CLAUDE.md hard rule 5 does not apply).
CREATE TABLE IF NOT EXISTS alerts_sent (
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, kind, day)
);
