-- contract: drops cron_run_history (and its six indexes with it), retired by 0081. Since Foxhound #682 every run is
-- kept in site-runtime's cron_run_log and nothing reads or writes cron_run_history; 0081 copied each job's runs from the
-- last 90 days into the log. Also deletes the cron_runs row of retention-cron-history, the sweep #682 removed, so no
-- stale record of a job that no longer exists is left. No money table is touched (CLAUDE.md hard rule 5 does not
-- apply). The deploy refuses a contract migration, so it is applied by hand after a D1 Time Travel bookmark.
DROP TABLE `cron_run_history`;
--> statement-breakpoint
DELETE FROM cron_runs WHERE name = 'retention-cron-history';
