-- cron_run_history: runJobs reads each cron's newest finish with WHERE cron_name = ? ORDER BY finished_at DESC LIMIT n
-- (cron/run.ts). The (cron_name, status, finished_at) index cannot serve that order without a status, so every tick
-- sorted the cron's whole 90-day history: 27.7K calls and 577M rows read in 30 days (D1 counts rows scanned,
-- developers.cloudflare.com/d1/platform/pricing/). Additive: one index, no row touched.
CREATE INDEX IF NOT EXISTS cron_run_history_cron_finished_idx ON cron_run_history (cron_name, finished_at);
