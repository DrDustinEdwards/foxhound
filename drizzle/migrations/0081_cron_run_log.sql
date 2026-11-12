-- site-runtime ./cron's CRON_LOG_SQL, as its README asks: cron_run_log, which runJobs writes with `history` on (one row
-- per run, its outcome and one-line reason, the newest 1,500 per job and none older than 90 days) and the admin Crons
-- page and the alerts read. It replaces Foxhound's own cron_run_history, a second ledger beside cron_runs; 0082 drops
-- that table by hand once this code is live. The statement is the package's own; the snapshot is drizzle-kit's for
-- app/db/schema/platform.ts.
--
-- Then each job's runs inside those bounds are copied from cron_run_history, oldest first so the ids run in time
-- order (readCronRuns reads newest by id): success is "ok", the message is the reason, on one line and cut to 300
-- characters, as runJobs writes it. retention-cron-history is left out: the log prunes itself, so that job is gone.
-- ADDITIVE: one new table and rows copied into it; nothing is changed or deleted and no money table is touched
-- (CLAUDE.md hard rule 5 does not apply).
CREATE TABLE IF NOT EXISTS cron_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cron_run_log_name ON cron_run_log (name, id);
--> statement-breakpoint
INSERT INTO cron_run_log (name, started_at, finished_at, outcome, reason)
SELECT
  cron_name,
  COALESCE(started_at, finished_at),
  finished_at,
  CASE status WHEN 'success' THEN 'ok' ELSE 'failed' END,
  substr(trim(replace(replace(COALESCE(message, ''), char(13), ' '), char(10), ' ')), 1, 300)
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY cron_name ORDER BY finished_at DESC) AS rank
  FROM cron_run_history
  WHERE status IN ('success', 'failed')
    AND cron_name <> 'retention-cron-history'
    AND finished_at >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 90 * 86400000
)
WHERE rank <= 1500
ORDER BY finished_at, id;
