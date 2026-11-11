-- contract: drops cron_alerts, retired by 0077. Since Foxhound #640 the cron health check and the
-- dead-letter alert claim their slot in alerts_sent (site-runtime ./cron-alert), and nothing reads or
-- writes cron_alerts. Its rows were one-per-day mail dedupe claims with no history worth keeping. No
-- money table is touched (CLAUDE.md hard rule 5 does not apply). The deploy refuses a contract
-- migration, so it is applied by hand: npx wrangler d1 migrations apply foxhound --remote.
DROP TABLE `cron_alerts`;
