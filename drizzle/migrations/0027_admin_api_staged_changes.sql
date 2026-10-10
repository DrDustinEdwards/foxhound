CREATE TABLE `admin_api_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`api_key_id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`input` text,
	`status` integer NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_api_calls_created_idx` ON `admin_api_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `staged_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_account_id` text,
	`target_cron_name` text,
	`params` text,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`requested_via` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`result` text,
	FOREIGN KEY (`target_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staged_changes_status_idx` ON `staged_changes` (`status`,`requested_at`);--> statement-breakpoint
CREATE TRIGGER `admin_api_calls_no_update` BEFORE UPDATE ON `admin_api_calls`
BEGIN
	SELECT RAISE(ABORT, 'admin_api_calls is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `admin_api_calls_no_delete` BEFORE DELETE ON `admin_api_calls`
BEGIN
	SELECT RAISE(ABORT, 'admin_api_calls is append-only');
END;
