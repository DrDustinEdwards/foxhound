-- contract: rebuilds four tables to make account_id NOT NULL (prod had 0 NULL rows). Hand-run with a Time Travel bookmark.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_expiring_card_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_name` text,
	`card_last4` text,
	`card_brand` text,
	`expires_month` integer NOT NULL,
	`expires_year` integer NOT NULL,
	`alert_sent_at` integer,
	`created_at` integer NOT NULL,
	`account_id` text NOT NULL,
	`stripe_connection_id` text,
	`deleted_at` integer,
	`reason` text DEFAULT 'card_expiring' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_expiring_card_alerts`("id", "stripe_customer_id", "customer_email", "customer_name", "card_last4", "card_brand", "expires_month", "expires_year", "alert_sent_at", "created_at", "account_id", "stripe_connection_id", "deleted_at", "reason") SELECT "id", "stripe_customer_id", "customer_email", "customer_name", "card_last4", "card_brand", "expires_month", "expires_year", "alert_sent_at", "created_at", "account_id", "stripe_connection_id", "deleted_at", "reason" FROM `expiring_card_alerts`;--> statement-breakpoint
DROP TABLE `expiring_card_alerts`;--> statement-breakpoint
ALTER TABLE `__new_expiring_card_alerts` RENAME TO `expiring_card_alerts`;--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX `expiring_card_alerts_account_idx` ON `expiring_card_alerts` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `expiring_card_alerts_card_month_uq` ON `expiring_card_alerts` (`account_id`,`stripe_customer_id`,`expires_month`,`expires_year`);--> statement-breakpoint
CREATE TABLE `__new_win_back_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_name` text,
	`plan_name` text,
	`amount_cents` integer,
	`currency` text,
	`cancel_reason` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`reactivated_at` integer,
	`reactivated_by_step_id` text,
	`account_id` text NOT NULL,
	`stripe_connection_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_win_back_sequences`("id", "stripe_customer_id", "stripe_subscription_id", "customer_email", "customer_name", "plan_name", "amount_cents", "currency", "cancel_reason", "status", "created_at", "resolved_at", "reactivated_at", "reactivated_by_step_id", "account_id", "stripe_connection_id") SELECT "id", "stripe_customer_id", "stripe_subscription_id", "customer_email", "customer_name", "plan_name", "amount_cents", "currency", "cancel_reason", "status", "created_at", "resolved_at", "reactivated_at", "reactivated_by_step_id", "account_id", "stripe_connection_id" FROM `win_back_sequences`;--> statement-breakpoint
DROP TABLE `win_back_sequences`;--> statement-breakpoint
ALTER TABLE `__new_win_back_sequences` RENAME TO `win_back_sequences`;--> statement-breakpoint
CREATE INDEX `win_back_sequences_account_idx` ON `win_back_sequences` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `win_back_sequences_subscription_uq` ON `win_back_sequences` (`stripe_subscription_id`);--> statement-breakpoint
CREATE TABLE `__new_win_back_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`win_back_sequence_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`scheduled_at` integer NOT NULL,
	`executed_at` integer,
	`result` text,
	`ai_subject` text,
	`ai_body_html` text,
	`opened_at` integer,
	`clicked_at` integer,
	`account_id` text NOT NULL,
	`deleted_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_error` text,
	`next_retry_at` integer,
	FOREIGN KEY (`win_back_sequence_id`) REFERENCES `win_back_sequences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_win_back_steps`("id", "win_back_sequence_id", "step_number", "scheduled_at", "executed_at", "result", "ai_subject", "ai_body_html", "opened_at", "clicked_at", "account_id", "deleted_at", "attempt_count", "last_attempt_error", "next_retry_at") SELECT "id", "win_back_sequence_id", "step_number", "scheduled_at", "executed_at", "result", "ai_subject", "ai_body_html", "opened_at", "clicked_at", "account_id", "deleted_at", "attempt_count", "last_attempt_error", "next_retry_at" FROM `win_back_steps`;--> statement-breakpoint
DROP TABLE `win_back_steps`;--> statement-breakpoint
ALTER TABLE `__new_win_back_steps` RENAME TO `win_back_steps`;--> statement-breakpoint
CREATE INDEX `win_back_steps_sequence_idx` ON `win_back_steps` (`win_back_sequence_id`);--> statement-breakpoint
CREATE INDEX `win_back_steps_account_idx` ON `win_back_steps` (`account_id`);--> statement-breakpoint
CREATE TABLE `__new_intelligence_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`report_month` integer NOT NULL,
	`narrative` text NOT NULL,
	`generated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_intelligence_reports`("id", "account_id", "report_month", "narrative", "generated_at") SELECT "id", "account_id", "report_month", "narrative", "generated_at" FROM `intelligence_reports`;--> statement-breakpoint
DROP TABLE `intelligence_reports`;--> statement-breakpoint
ALTER TABLE `__new_intelligence_reports` RENAME TO `intelligence_reports`;--> statement-breakpoint
CREATE INDEX `intelligence_reports_account_idx` ON `intelligence_reports` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `intelligence_reports_account_month_uq` ON `intelligence_reports` (`account_id`,`report_month`);
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
