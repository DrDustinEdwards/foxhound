CREATE TABLE `recommendation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`recommended_at` integer NOT NULL,
	`action` text NOT NULL,
	`confidence` text NOT NULL,
	`rationale` text NOT NULL,
	`engagement_band` text NOT NULL,
	`recovery_band` text NOT NULL,
	`value_band` text NOT NULL,
	`evidence` text NOT NULL,
	`annualized_mrr_at_risk_cents` integer,
	`currency` text,
	`score_source` text NOT NULL,
	`outcome` text,
	`outcome_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recommendation_log_account_idx` ON `recommendation_log` (`account_id`);--> statement-breakpoint
CREATE INDEX `recommendation_log_customer_idx` ON `recommendation_log` (`stripe_customer_id`);--> statement-breakpoint
ALTER TABLE `customer_context` ADD `recommended_action` text;