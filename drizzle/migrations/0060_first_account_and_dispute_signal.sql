CREATE TABLE `account_first_creations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_first_creations_user_uq` ON `account_first_creations` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_first_creations_account_idx` ON `account_first_creations` (`account_id`);--> statement-breakpoint
ALTER TABLE `failed_payments` ADD `dispute_signal_at` integer;