-- contract: drops nine tables nothing in Foxhound writes or reads: the six social_* tables (Recova's Reddit scout, carried
-- by the legacy import and never built here), platform_stats, customer_notes and intelligence_notification_preferences.
-- Their only references were the retention sweep of social_leads, its count on the admin Operations page and the
-- account-deletion deletes, all removed with this migration. Children before parents (social_posts -> social_leads ->
-- social_keywords), because D1 enforces foreign keys and a DROP of a referenced table deletes its rows first. Also
-- deletes the cron_runs and cron_config rows of retention-social-leads, the sweep removed here, as 0082 did. No money
-- table is touched (CLAUDE.md hard rule 5 does not apply). The deploy refuses a contract migration, so it is applied by
-- hand after a D1 Time Travel bookmark.
DROP TABLE `social_posts`;--> statement-breakpoint
DROP TABLE `social_leads`;--> statement-breakpoint
DROP TABLE `social_keywords`;--> statement-breakpoint
DROP TABLE `social_config`;--> statement-breakpoint
DROP TABLE `social_topic_log`;--> statement-breakpoint
DROP TABLE `social_blocklist`;--> statement-breakpoint
DROP TABLE `platform_stats`;--> statement-breakpoint
DROP TABLE `customer_notes`;--> statement-breakpoint
DROP TABLE `intelligence_notification_preferences`;--> statement-breakpoint
DELETE FROM cron_runs WHERE name = 'retention-social-leads';--> statement-breakpoint
DELETE FROM cron_config WHERE cron_name = 'retention-social-leads';
