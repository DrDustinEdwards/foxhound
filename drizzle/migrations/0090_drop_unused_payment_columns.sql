-- contract: drops 13 never-filled columns of failed_payments and 3 of recovered_payments (customer_ltv_cents, stripe_product_id,
-- stripe_price_id, customer_timezone, time_of_failure_hour, failure_day_of_week, prior_failure_count, is_first_failure_ever,
-- merchant_mrr_range, merchant_industry, plan_interval, amount_tier, ab_test_group; recovery_step_type, recovery_attempt_number,
-- recovery_trigger). Nothing reads or writes them; production holds NULL in every one except recovery_step_type, a copy of
-- recovery_steps.step_type on the 60 demo rows. No column is indexed and the tables are not recreated (plain DROP COLUMN), so no
-- money row changes. The deploy refuses a contract migration, so it is applied by hand after a D1 Time Travel bookmark.
ALTER TABLE `failed_payments` DROP COLUMN `customer_ltv_cents`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `stripe_product_id`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `stripe_price_id`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `customer_timezone`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `time_of_failure_hour`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `failure_day_of_week`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `prior_failure_count`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `is_first_failure_ever`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `merchant_mrr_range`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `merchant_industry`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `plan_interval`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `amount_tier`;--> statement-breakpoint
ALTER TABLE `failed_payments` DROP COLUMN `ab_test_group`;--> statement-breakpoint
ALTER TABLE `recovered_payments` DROP COLUMN `recovery_step_type`;--> statement-breakpoint
ALTER TABLE `recovered_payments` DROP COLUMN `recovery_attempt_number`;--> statement-breakpoint
ALTER TABLE `recovered_payments` DROP COLUMN `recovery_trigger`;