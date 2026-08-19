CREATE TABLE `audit_digest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`period_month` text NOT NULL,
	`totals` text,
	`status` text NOT NULL,
	`error` text,
	`sent_at` integer,
	`cron_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_digest_runs_account_period_uq` ON `audit_digest_runs` (`account_id`,`period_month`);