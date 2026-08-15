CREATE TABLE `cron_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`cron_name` text NOT NULL,
	`kind` text NOT NULL,
	`alerted_on` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_alerts_dedupe_uq` ON `cron_alerts` (`cron_name`,`kind`,`alerted_on`);--> statement-breakpoint
CREATE TABLE `email_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`recovery_step_id` text,
	`win_back_step_id` text,
	`queue_message_id` text,
	`template` text,
	`recipient_hash` text,
	`attempts` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_dead_letters_account_idx` ON `email_dead_letters` (`account_id`);--> statement-breakpoint
ALTER TABLE `email_sends` ADD `cron_run_id` text;