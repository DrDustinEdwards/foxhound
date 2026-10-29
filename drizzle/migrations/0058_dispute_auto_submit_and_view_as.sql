CREATE TABLE `admin_impersonations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`admin_email` text NOT NULL,
	`account_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_impersonations_token_hash_uq` ON `admin_impersonations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admin_impersonations_account_idx` ON `admin_impersonations` (`account_id`);--> statement-breakpoint
ALTER TABLE `dispute_approvals` ADD `standing_opt_in_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_by_user_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_by_email` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_at` integer;