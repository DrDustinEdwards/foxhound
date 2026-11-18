ALTER TABLE `billing_line_items` ADD `refunded_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `failed_payments` ADD `refund_signal_cents` integer;--> statement-breakpoint
ALTER TABLE `recovered_payments` ADD `refunded_cents` integer DEFAULT 0 NOT NULL;