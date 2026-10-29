CREATE TABLE `dispute_balance_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_dispute_id` text NOT NULL,
	`stripe_balance_transaction_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`fee_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dispute_balance_transactions_kind_ck" CHECK("dispute_balance_transactions"."kind" in ('withdrawn', 'reinstated'))
);
--> statement-breakpoint
CREATE INDEX `dispute_balance_transactions_dispute_idx` ON `dispute_balance_transactions` (`account_id`,`stripe_dispute_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dispute_balance_transactions_bt_uq` ON `dispute_balance_transactions` (`stripe_balance_transaction_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_dispute_id` text NOT NULL,
	`stripe_charge_id` text NOT NULL,
	`stripe_customer_id` text,
	`customer_email` text,
	`customer_name` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`outcome_amount_cents` integer,
	`evidence_deadline` integer,
	`ai_response_text` text,
	`ai_generated_at` integer,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`stripe_connection_id` text,
	`resolved_at` integer,
	`customer_id` text,
	`customer_ip` text,
	`billing_address` text,
	`avs_result` text,
	`cvv_result` text,
	`radar_risk_score` integer,
	`radar_risk_level` text,
	`three_d_secure` text,
	`prior_charges_count` integer,
	`prior_charges_total` integer,
	`prior_charges_json` text,
	`subscription_json` text,
	`recovery_emails_json` text,
	`smart_disputes_status` text,
	`structured_evidence_json` text,
	`triage_recommendation` text,
	`triage_confidence` integer,
	`triage_reasoning` text,
	`submitted_by` text,
	`staged_at` integer,
	`outcome_notified_at` integer,
	`shipping_tracking_number` text,
	`shipping_carrier` text,
	`shipping_date` integer,
	`state` text DEFAULT 'draft' NOT NULL,
	`resolved_fee_cents` integer,
	`resolved_fee_currency` text,
	`resolved_fee_rate` real,
	`resolved_fee_quote_id` text,
	`resolved_fee_rate_at` integer,
	`resolved_fee_error` text,
	`stripe_has_evidence` integer,
	`stripe_submission_count` integer,
	`stripe_synced_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "disputes_state_ck" CHECK("__new_disputes"."state" in ('draft', 'pending_review', 'approved', 'submitted', 'resolved_won', 'resolved_lost', 'inquiry_closed'))
);
--> statement-breakpoint
INSERT INTO `__new_disputes`("id", "account_id", "stripe_dispute_id", "stripe_charge_id", "stripe_customer_id", "customer_email", "customer_name", "amount_cents", "currency", "reason", "status", "outcome", "outcome_amount_cents", "evidence_deadline", "ai_response_text", "ai_generated_at", "submitted_at", "created_at", "stripe_connection_id", "resolved_at", "customer_id", "customer_ip", "billing_address", "avs_result", "cvv_result", "radar_risk_score", "radar_risk_level", "three_d_secure", "prior_charges_count", "prior_charges_total", "prior_charges_json", "subscription_json", "recovery_emails_json", "smart_disputes_status", "structured_evidence_json", "triage_recommendation", "triage_confidence", "triage_reasoning", "submitted_by", "staged_at", "outcome_notified_at", "shipping_tracking_number", "shipping_carrier", "shipping_date", "state", "resolved_fee_cents", "resolved_fee_currency", "resolved_fee_rate", "resolved_fee_quote_id", "resolved_fee_rate_at", "resolved_fee_error") SELECT "id", "account_id", "stripe_dispute_id", "stripe_charge_id", "stripe_customer_id", "customer_email", "customer_name", "amount_cents", "currency", "reason", "status", "outcome", "outcome_amount_cents", "evidence_deadline", "ai_response_text", "ai_generated_at", "submitted_at", "created_at", "stripe_connection_id", "resolved_at", "customer_id", "customer_ip", "billing_address", "avs_result", "cvv_result", "radar_risk_score", "radar_risk_level", "three_d_secure", "prior_charges_count", "prior_charges_total", "prior_charges_json", "subscription_json", "recovery_emails_json", "smart_disputes_status", "structured_evidence_json", "triage_recommendation", "triage_confidence", "triage_reasoning", "submitted_by", "staged_at", "outcome_notified_at", "shipping_tracking_number", "shipping_carrier", "shipping_date", "state", "resolved_fee_cents", "resolved_fee_currency", "resolved_fee_rate", "resolved_fee_quote_id", "resolved_fee_rate_at", "resolved_fee_error" FROM `disputes`;--> statement-breakpoint
DROP TABLE `disputes`;--> statement-breakpoint
ALTER TABLE `__new_disputes` RENAME TO `disputes`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE INDEX `disputes_account_idx` ON `disputes` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `disputes_stripe_dispute_uq` ON `disputes` (`stripe_dispute_id`);