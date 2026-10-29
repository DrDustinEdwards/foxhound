CREATE TABLE `subscription_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`stripe_event_id` text NOT NULL,
	`kind` text NOT NULL,
	`cancel_at` integer,
	`resumes_at` integer,
	`previous_mrr_cents` integer,
	`current_mrr_cents` integer,
	`currency` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscription_changes_account_customer_idx` ON `subscription_changes` (`account_id`,`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_changes_event_kind_uq` ON `subscription_changes` (`stripe_event_id`,`kind`);