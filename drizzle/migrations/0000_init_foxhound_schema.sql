CREATE TABLE `account_members` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text,
	`role` text NOT NULL,
	`invited_email` text,
	`status` text NOT NULL,
	`invite_token` text,
	`invite_expires_at` integer,
	`created_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_members_account_idx` ON `account_members` (`account_id`);--> statement-breakpoint
CREATE TABLE `account_products` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product` text NOT NULL,
	`status` text NOT NULL,
	`stripe_subscription_item_id` text,
	`activated_at` integer,
	`cancelled_at` integer,
	`trial_ends_at` integer,
	`created_at` integer,
	`stripe_connection_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_products_account_idx` ON `account_products` (`account_id`);--> statement-breakpoint
CREATE TABLE `account_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product` text NOT NULL,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`status` text NOT NULL,
	`billing_interval` text,
	`current_period_ends_at` integer,
	`trial_ends_at` integer,
	`created_at` integer NOT NULL,
	`canceled_at` integer,
	`stripe_connection_id` text,
	`cancellation_reason` text,
	`cancellation_feedback` text,
	`admin_granted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_subscriptions_account_idx` ON `account_subscriptions` (`account_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`notification_email` text,
	`slack_webhook_url` text,
	`digest_enabled` integer,
	`recovery_notifications_enabled` integer,
	`sequence_complete_notifications_enabled` integer,
	`winback_notifications_enabled` integer,
	`expiring_card_notifications_enabled` integer,
	`onboarding_completed` integer,
	`created_at` integer,
	`mrr_estimate_cents` integer,
	`merchant_industry` text,
	`primary_customer_type` text,
	`merchant_mrr_self_reported` integer,
	`slack_notifications_enabled` integer,
	`digest_email` text,
	`last_visited_path` text,
	`last_visited_product` text,
	`billing_exempt` integer DEFAULT false NOT NULL,
	`processing_paused` integer DEFAULT false NOT NULL,
	`dispute_product_description` text,
	`dispute_ships_physical` integer,
	`dispute_auto_submit` integer,
	`audit_lookback_days` integer,
	`audit_auto_run` integer,
	`theme` text DEFAULT 'dark' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text,
	`target_email` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`source` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cost_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`related_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_calls_account_idx` ON `ai_calls` (`account_id`);--> statement-breakpoint
CREATE TABLE `alert_history` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`account_id` text NOT NULL,
	`metric` text NOT NULL,
	`threshold_value` real NOT NULL,
	`direction` text NOT NULL,
	`actual_value` real NOT NULL,
	`channel` text NOT NULL,
	`fired_at` integer NOT NULL,
	`notification_sent` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alert_history_account_idx` ON `alert_history` (`account_id`);--> statement-breakpoint
CREATE INDEX `alert_history_alert_idx` ON `alert_history` (`alert_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`metric` text NOT NULL,
	`threshold_value` real NOT NULL,
	`direction` text NOT NULL,
	`channel` text NOT NULL,
	`label` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_triggered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alerts_account_idx` ON `alerts` (`account_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`key_hash` text NOT NULL,
	`label` text,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_keys_account_idx` ON `api_keys` (`account_id`);--> statement-breakpoint
CREATE TABLE `audit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`stripe_account_id` text,
	`run_at` integer NOT NULL,
	`lookback_days` integer NOT NULL,
	`failed_invoices_count` integer,
	`failed_invoices_cents` integer,
	`expiring_cards_count` integer,
	`expiring_cards_mrr_cents` integer,
	`past_due_subscriptions_count` integer,
	`past_due_subscriptions_cents` integer,
	`open_disputes_count` integer,
	`open_disputes_cents` integer,
	`disputes_accepted_count` integer,
	`disputes_won` integer,
	`disputes_lost` integer,
	`mrr_cents` integer,
	`arr_cents` integer,
	`active_subscriptions_count` integer,
	`voluntary_churn_rate_bps` integer,
	`involuntary_churn_rate_bps` integer,
	`ai_summary` text,
	`decline_breakdown` text,
	`is_authenticated` integer,
	`created_at` integer NOT NULL,
	`disputes_accepted_cents` integer,
	`currency` text,
	`card_updater_events_in_window` integer,
	`card_updater_expired_declines_in_window` integer,
	`card_updater_advisory` text,
	`expires_by_month` text,
	`stripe_baseline_recovered_cents` integer,
	`still_dying_cents` integer,
	`foxhound_adds_cents` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_runs_account_idx` ON `audit_runs` (`account_id`);--> statement-breakpoint
CREATE TABLE `benchmark_data` (
	`id` text PRIMARY KEY NOT NULL,
	`computed_at` integer NOT NULL,
	`cohort_dimension` text NOT NULL,
	`cohort_value` text NOT NULL,
	`sample_size` integer NOT NULL,
	`metric_name` text NOT NULL,
	`p10` real,
	`p25` real,
	`p50` real,
	`p75` real,
	`p90` real,
	`mean` real,
	`currency` text
);
--> statement-breakpoint
CREATE TABLE `billing_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`currency` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`stripe_invoice_id` text,
	`stripe_invoice_url` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `billing_invoices_account_idx` ON `billing_invoices` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_invoices_idempotency_uq` ON `billing_invoices` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `billing_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`account_id` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`fee_cents` integer,
	`recovered_payment_id` text,
	`dispute_id` text,
	`admin_audit_log_id` text,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `billing_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovered_payment_id`) REFERENCES `recovered_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`admin_audit_log_id`) REFERENCES `admin_audit_log`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "billing_line_items_type_ck" CHECK("billing_line_items"."type" in ('recovery_fee', 'dispute_fee', 'subscription', 'adjustment'))
);
--> statement-breakpoint
CREATE INDEX `billing_line_items_invoice_idx` ON `billing_line_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `billing_line_items_account_idx` ON `billing_line_items` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_line_items_recovery_uq` ON `billing_line_items` (`recovered_payment_id`) WHERE "billing_line_items"."recovered_payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_line_items_dispute_uq` ON `billing_line_items` (`dispute_id`) WHERE "billing_line_items"."dispute_id" is not null;--> statement-breakpoint
CREATE TABLE `blog_post_links` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `blog_posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `blog_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blog_post_links_source_idx` ON `blog_post_links` (`source_id`);--> statement-breakpoint
CREATE TABLE `blog_post_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`excerpt` text NOT NULL,
	`saved_at` integer NOT NULL,
	`saved_by` text,
	FOREIGN KEY (`post_id`) REFERENCES `blog_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blog_post_versions_post_idx` ON `blog_post_versions` (`post_id`);--> statement-breakpoint
CREATE TABLE `blog_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text NOT NULL,
	`body` text NOT NULL,
	`cover_image_url` text,
	`cover_image_alt` text,
	`published` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`author` text NOT NULL,
	`tags` text NOT NULL,
	`og_title` text,
	`og_description` text,
	`canonical_url` text,
	`show_updated_at` integer DEFAULT true NOT NULL,
	`show_published_at` integer DEFAULT true NOT NULL,
	`featured` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blog_posts_slug_uq` ON `blog_posts` (`slug`);--> statement-breakpoint
CREATE TABLE `cron_config` (
	`cron_name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`min_interval_minutes` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cron_run_history` (
	`id` text PRIMARY KEY NOT NULL,
	`cron_name` text NOT NULL,
	`started_at` integer,
	`finished_at` integer NOT NULL,
	`status` text NOT NULL,
	`rows_processed` integer,
	`message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cron_run_history_cron_idx` ON `cron_run_history` (`cron_name`);--> statement-breakpoint
CREATE TABLE `customer_context` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`customer_email` text,
	`customer_name` text,
	`customer_since` integer,
	`last_seen_at` integer,
	`mrr_contribution_cents` integer,
	`ltv_cents` integer,
	`active_subscriptions_count` integer,
	`current_plan_name` text,
	`current_plan_tier` text,
	`recovery_signals` text,
	`dispute_signals` text,
	`engagement_signals` text,
	`health_score` integer,
	`health_score_calculated_at` integer,
	`health_factors` text,
	`ai_assessment` text,
	`ai_assessment_generated_at` integer,
	`ai_recommended_actions` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`subscription_age_days` integer,
	`plan_change_count` integer,
	`seat_change_count` integer,
	`interval_switch_count` integer,
	`payment_latency_drift_days` integer,
	`refund_count` integer,
	`dispute_count` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customer_context_account_idx` ON `customer_context` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_context_account_customer_uq` ON `customer_context` (`account_id`,`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `customer_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customer_notes_account_idx` ON `customer_notes` (`account_id`);--> statement-breakpoint
CREATE TABLE `dispute_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`dispute_id` text NOT NULL,
	`account_id` text NOT NULL,
	`approved_by_user_id` text,
	`approved_by_email` text,
	`evidence_version_hash` text NOT NULL,
	`approved_at` integer NOT NULL,
	FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dispute_approvals_account_idx` ON `dispute_approvals` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dispute_approvals_dispute_uq` ON `dispute_approvals` (`dispute_id`);--> statement-breakpoint
CREATE TABLE `dispute_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`dispute_id` text NOT NULL,
	`account_id` text NOT NULL,
	`field_name` text NOT NULL,
	`field_value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dispute_evidence_account_idx` ON `dispute_evidence` (`account_id`);--> statement-breakpoint
CREATE INDEX `dispute_evidence_dispute_idx` ON `dispute_evidence` (`dispute_id`);--> statement-breakpoint
CREATE TABLE `disputes` (
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
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "disputes_state_ck" CHECK("disputes"."state" in ('draft', 'pending_review', 'approved', 'submitted', 'resolved_won', 'resolved_lost'))
);
--> statement-breakpoint
CREATE INDEX `disputes_account_idx` ON `disputes` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `disputes_stripe_dispute_uq` ON `disputes` (`stripe_dispute_id`);--> statement-breakpoint
CREATE TABLE `email_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`recovery_step_id` text,
	`win_back_step_id` text,
	`queue_message_id` text,
	`template` text,
	`recipient_hash` text,
	`status` text NOT NULL,
	`provider_message_id` text,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovery_step_id`) REFERENCES `recovery_steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`win_back_step_id`) REFERENCES `win_back_steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_sends_account_idx` ON `email_sends` (`account_id`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`suppressed_at` integer,
	`account_id` text,
	`reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_suppressions_account_idx` ON `email_suppressions` (`account_id`);--> statement-breakpoint
CREATE INDEX `email_suppressions_email_idx` ON `email_suppressions` (`email`);--> statement-breakpoint
CREATE TABLE `engagement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`email_send_id` text,
	`recovery_step_id` text,
	`event_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`target_url` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`email_send_id`) REFERENCES `email_sends`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovery_step_id`) REFERENCES `recovery_steps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "engagement_events_type_ck" CHECK("engagement_events"."event_type" in ('open', 'click'))
);
--> statement-breakpoint
CREATE INDEX `engagement_events_account_idx` ON `engagement_events` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `engagement_events_idempotency_uq` ON `engagement_events` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `estimator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`mrr_cents` integer,
	`customer_count` integer,
	`currency` text,
	`estimated_leakage_cents` integer,
	`benchmark_cohort` text,
	`result_json` text
);
--> statement-breakpoint
CREATE TABLE `expiring_card_alerts` (
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
	`account_id` text,
	`stripe_connection_id` text,
	`deleted_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expiring_card_alerts_account_idx` ON `expiring_card_alerts` (`account_id`);--> statement-breakpoint
CREATE TABLE `failed_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`stripe_invoice_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_name` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`decline_code` text,
	`decline_category` text NOT NULL,
	`plan_name` text,
	`customer_since` integer,
	`status` text NOT NULL,
	`detected_at` integer NOT NULL,
	`resolved_at` integer,
	`notes` text,
	`card_brand` text,
	`card_country` text,
	`card_funding` text,
	`customer_ltv_cents` integer,
	`stripe_product_id` text,
	`stripe_price_id` text,
	`customer_timezone` text,
	`deleted_at` integer,
	`processor` text,
	`processor_payment_id` text,
	`processor_customer_id` text,
	`subscription_start` integer,
	`subscription_id` text,
	`time_of_failure_hour` integer,
	`failure_day_of_week` integer,
	`prior_failure_count` integer,
	`is_first_failure_ever` integer,
	`merchant_mrr_range` text,
	`merchant_industry` text,
	`plan_interval` text,
	`amount_tier` text,
	`ab_test_group` text,
	`customer_age_days` integer,
	`account_id` text NOT NULL,
	`stripe_connection_id` text,
	`is_renewal_noise` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `failed_payments_account_idx` ON `failed_payments` (`account_id`);--> statement-breakpoint
CREATE INDEX `failed_payments_invoice_idx` ON `failed_payments` (`stripe_invoice_id`);--> statement-breakpoint
CREATE TABLE `health_score_history` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`customer_context_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`health_score` integer NOT NULL,
	`health_factors` text NOT NULL,
	`score_source` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_context_id`) REFERENCES `customer_context`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `health_score_history_account_idx` ON `health_score_history` (`account_id`);--> statement-breakpoint
CREATE INDEX `health_score_history_customer_idx` ON `health_score_history` (`customer_context_id`);--> statement-breakpoint
CREATE TABLE `intelligence_notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`weekly_narrative_email` integer DEFAULT true NOT NULL,
	`weekly_narrative_slack` integer DEFAULT false NOT NULL,
	`health_alert_email` integer DEFAULT true NOT NULL,
	`health_alert_slack` integer DEFAULT false NOT NULL,
	`health_alert_threshold` integer DEFAULT 50 NOT NULL,
	`expansion_alert_email` integer DEFAULT true NOT NULL,
	`expansion_alert_slack` integer DEFAULT false NOT NULL,
	`competitor_alert_email` integer DEFAULT false NOT NULL,
	`competitor_alert_slack` integer DEFAULT false NOT NULL,
	`anomaly_alert_email` integer DEFAULT true NOT NULL,
	`anomaly_alert_slack` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intelligence_notif_prefs_account_idx` ON `intelligence_notification_preferences` (`account_id`);--> statement-breakpoint
CREATE TABLE `intelligence_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`report_month` integer NOT NULL,
	`narrative` text NOT NULL,
	`generated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intelligence_reports_account_idx` ON `intelligence_reports` (`account_id`);--> statement-breakpoint
CREATE TABLE `mrr_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`snapshot_date` integer NOT NULL,
	`total_mrr_cents` integer NOT NULL,
	`new_mrr_cents` integer NOT NULL,
	`expansion_mrr_cents` integer NOT NULL,
	`contraction_mrr_cents` integer NOT NULL,
	`churn_mrr_cents` integer NOT NULL,
	`reactivation_mrr_cents` integer NOT NULL,
	`active_customers_count` integer NOT NULL,
	`new_customers_count` integer NOT NULL,
	`churned_customers_count` integer NOT NULL,
	`per_plan_breakdown` text NOT NULL,
	`per_cohort_breakdown` text NOT NULL,
	`per_channel_breakdown` text NOT NULL,
	`voluntary_churn_rate_bps` integer,
	`involuntary_churn_rate_bps` integer,
	`net_revenue_retention_bps` integer,
	`gross_revenue_retention_bps` integer,
	`currency` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mrr_snapshots_account_idx` ON `mrr_snapshots` (`account_id`);--> statement-breakpoint
CREATE TABLE `outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`product` text NOT NULL,
	`event_type` text NOT NULL,
	`event_data` text,
	`outcome` text,
	`outcome_at` integer,
	`created_at` integer,
	`idempotency_key` text,
	`attribution_kind` text,
	`attributed_ref` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outcomes_account_idx` ON `outcomes` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outcomes_idempotency_uq` ON `outcomes` (`idempotency_key`) WHERE "outcomes"."idempotency_key" is not null;--> statement-breakpoint
CREATE TABLE `page_404_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`day` integer NOT NULL,
	`path` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_404_daily_day_path_uq` ON `page_404_daily` (`day`,`path`);--> statement-breakpoint
CREATE TABLE `platform_stats` (
	`id` integer PRIMARY KEY NOT NULL,
	`total_recovered_usd` integer,
	`total_merchants` integer,
	`total_failed_detected` integer,
	`total_emails_sent` integer,
	`avg_recovery_rate_pct` real,
	`avg_hours_to_first_recovery` real,
	`last_computed_at` integer
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`score` integer NOT NULL,
	`band_evidence_hash` text,
	`horizon_days` integer NOT NULL,
	`predicted_at` integer NOT NULL,
	`realized_outcome` text,
	`graded_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `predictions_account_idx` ON `predictions` (`account_id`);--> statement-breakpoint
CREATE INDEX `predictions_customer_idx` ON `predictions` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `recovered_payments` (
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
	CONSTRAINT "recovered_payments_attribution_kind_ck" CHECK("recovered_payments"."attribution_kind" in ('foxhound_retry', 'email_engaged', 'card_update', 'stripe_baseline'))
);
--> statement-breakpoint
CREATE INDEX `recovered_payments_account_idx` ON `recovered_payments` (`account_id`);--> statement-breakpoint
CREATE INDEX `recovered_payments_failed_payment_idx` ON `recovered_payments` (`failed_payment_id`);--> statement-breakpoint
CREATE TABLE `recovery_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`failed_payment_id` text NOT NULL,
	`step_type` text NOT NULL,
	`step_number` integer,
	`scheduled_at` integer NOT NULL,
	`executed_at` integer,
	`result` text,
	`ai_subject` text,
	`ai_body_html` text,
	`opened_at` integer,
	`clicked_at` integer,
	`deleted_at` integer,
	`email_opened_count` integer,
	`email_clicked_count` integer,
	`last_opened_at` integer,
	`last_clicked_at` integer,
	`time_to_open_minutes` integer,
	`email_send_hour` integer,
	`email_send_day_of_week` integer,
	`retry_result` text,
	`ab_variant` text,
	`custom_body` text,
	`account_id` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_error` text,
	`next_retry_at` integer,
	FOREIGN KEY (`failed_payment_id`) REFERENCES `failed_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recovery_steps_account_idx` ON `recovery_steps` (`account_id`);--> statement-breakpoint
CREATE INDEX `recovery_steps_failed_payment_idx` ON `recovery_steps` (`failed_payment_id`);--> statement-breakpoint
CREATE TABLE `social_blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_config` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`post_enabled` integer DEFAULT false NOT NULL,
	`reply_enabled` integer DEFAULT false NOT NULL,
	`reddit_ready` integer DEFAULT false NOT NULL,
	`max_replies_per_day` integer NOT NULL,
	`min_intent_score` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`max_post_age_hours` integer NOT NULL,
	`min_upvotes` integer NOT NULL,
	`posts_per_week` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`query` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`is_competitor` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`lead_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`post_url` text NOT NULL,
	`post_id` text,
	`author` text,
	`title` text,
	`body` text,
	`subreddit` text,
	`intent_score` integer NOT NULL,
	`keywords_matched` text,
	`status` text NOT NULL,
	`reply_id` text,
	`reply_body` text,
	`scout_run_at` integer NOT NULL,
	`replied_at` integer,
	`skip_reason` text,
	`created_at` integer NOT NULL,
	`upvote_count` integer,
	`post_age_hours` integer,
	`filter_reason` text,
	`sentiment` text,
	`is_competitor_mention` integer DEFAULT false NOT NULL,
	`is_google_ranking` integer DEFAULT false NOT NULL,
	`generated_reply` text,
	`reply_approved_at` integer,
	`keyword_id` text,
	FOREIGN KEY (`keyword_id`) REFERENCES `social_keywords`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `social_leads_keyword_idx` ON `social_leads` (`keyword_id`);--> statement-breakpoint
CREATE TABLE `social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`post_type` text NOT NULL,
	`content` text NOT NULL,
	`platform_post_id` text,
	`lead_id` text,
	`status` text NOT NULL,
	`error` text,
	`posted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `social_leads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `social_posts_lead_idx` ON `social_posts` (`lead_id`);--> statement-breakpoint
CREATE TABLE `social_topic_log` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_key` text NOT NULL,
	`platform` text NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`stripe_user_id` text NOT NULL,
	`stripe_access_token` text,
	`stripe_publishable_key` text,
	`stripe_scope` text,
	`name` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`connected_at` integer,
	`disconnected_at` integer,
	`last_webhook_at` integer,
	`webhook_endpoint_id` text,
	`created_at` integer NOT NULL,
	`sender_name` text,
	`sender_domain` text,
	`reply_to_email` text,
	`brand_voice` text,
	`brand_voice_soft` text,
	`brand_voice_expired` text,
	`brand_voice_network` text,
	`brand_voice_fraud` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stripe_connections_account_idx` ON `stripe_connections` (`account_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`received_at` integer NOT NULL,
	`account_id` text,
	`processed` integer DEFAULT false NOT NULL,
	`error_message` text,
	`payload` text NOT NULL,
	`processing_started_at` integer
);
--> statement-breakpoint
CREATE INDEX `webhook_events_account_idx` ON `webhook_events` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_stripe_event_uq` ON `webhook_events` (`stripe_event_id`);--> statement-breakpoint
CREATE TABLE `win_back_sequences` (
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
	`account_id` text,
	`stripe_connection_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stripe_connection_id`) REFERENCES `stripe_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `win_back_sequences_account_idx` ON `win_back_sequences` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `win_back_sequences_subscription_uq` ON `win_back_sequences` (`stripe_subscription_id`);--> statement-breakpoint
CREATE TABLE `win_back_steps` (
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
	`account_id` text,
	`deleted_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_error` text,
	`next_retry_at` integer,
	FOREIGN KEY (`win_back_sequence_id`) REFERENCES `win_back_sequences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `win_back_steps_sequence_idx` ON `win_back_steps` (`win_back_sequence_id`);