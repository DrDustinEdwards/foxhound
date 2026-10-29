CREATE TABLE `early_fraud_warnings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_connection_id` text,
	`stripe_warning_id` text NOT NULL,
	`stripe_charge_id` text NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_customer_id` text,
	`customer_email` text,
	`customer_name` text,
	`failed_payment_id` text,
	`fraud_type` text NOT NULL,
	`actionable` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`refunded_at` integer,
	`stripe_refund_id` text,
	`dismissed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`failed_payment_id`) REFERENCES `failed_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `early_fraud_warnings_account_idx` ON `early_fraud_warnings` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `early_fraud_warnings_account_warning_uq` ON `early_fraud_warnings` (`account_id`,`stripe_warning_id`);