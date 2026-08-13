PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recovered_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`failed_payment_id` text NOT NULL,
	`recovered_at` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`recovery_method` text NOT NULL,
	`recovered_by_step_id` text,
	`deleted_at` integer,
	`recovery_step_type` text,
	`days_to_recover` integer,
	`recovery_attempt_number` integer,
	`recovery_trigger` text,
	`account_id` text NOT NULL,
	`refunded_at` integer,
	`attribution_kind` text DEFAULT 'stripe_baseline' NOT NULL,
	`attribution_ref` text,
	`attributed_at` integer,
	`disputed_at` integer,
	FOREIGN KEY (`failed_payment_id`) REFERENCES `failed_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovered_by_step_id`) REFERENCES `recovery_steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovered_payments_attribution_kind_ck" CHECK("__new_recovered_payments"."attribution_kind" in ('foxhound_retry', 'email_engaged', 'card_update', 'stripe_baseline', 'manual'))
);
--> statement-breakpoint
INSERT INTO `__new_recovered_payments`("id", "failed_payment_id", "recovered_at", "amount_cents", "currency", "recovery_method", "recovered_by_step_id", "deleted_at", "recovery_step_type", "days_to_recover", "recovery_attempt_number", "recovery_trigger", "account_id", "refunded_at", "attribution_kind", "attribution_ref", "attributed_at", "disputed_at") SELECT "id", "failed_payment_id", "recovered_at", "amount_cents", "currency", "recovery_method", "recovered_by_step_id", "deleted_at", "recovery_step_type", "days_to_recover", "recovery_attempt_number", "recovery_trigger", "account_id", "refunded_at", "attribution_kind", "attribution_ref", "attributed_at", "disputed_at" FROM `recovered_payments`;--> statement-breakpoint
DROP TABLE `recovered_payments`;--> statement-breakpoint
ALTER TABLE `__new_recovered_payments` RENAME TO `recovered_payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recovered_payments_account_idx` ON `recovered_payments` (`account_id`);--> statement-breakpoint
CREATE INDEX `recovered_payments_failed_payment_idx` ON `recovered_payments` (`failed_payment_id`);