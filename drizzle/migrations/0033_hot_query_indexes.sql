CREATE INDEX `account_members_user_idx` ON `account_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_keys_key_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `cron_run_history_created_idx` ON `cron_run_history` (`created_at`);--> statement-breakpoint
CREATE INDEX `cron_run_history_finished_idx` ON `cron_run_history` (`finished_at`);--> statement-breakpoint
CREATE INDEX `email_sends_created_idx` ON `email_sends` (`created_at`);--> statement-breakpoint
CREATE INDEX `engagement_events_occurred_idx` ON `engagement_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `health_score_history_recorded_idx` ON `health_score_history` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `social_leads_scout_run_idx` ON `social_leads` (`scout_run_at`);--> statement-breakpoint
CREATE INDEX `webhook_events_received_idx` ON `webhook_events` (`received_at`);--> statement-breakpoint
-- D1 "Use indexes": refresh the planner statistics after adding indexes.
PRAGMA optimize;