ALTER TABLE `recovered_payments` ADD `stripe_balance_transaction_id` text;--> statement-breakpoint
ALTER TABLE `recovered_payments` ADD `stripe_fee_cents` integer;--> statement-breakpoint
ALTER TABLE `recovered_payments` ADD `net_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `recovered_payments` ADD `net_currency` text;