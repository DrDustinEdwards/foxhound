ALTER TABLE `stripe_connections` ADD `charges_enabled` integer;--> statement-breakpoint
ALTER TABLE `stripe_connections` ADD `payouts_enabled` integer;--> statement-breakpoint
ALTER TABLE `stripe_connections` ADD `disabled_reason` text;--> statement-breakpoint
ALTER TABLE `stripe_connections` ADD `past_due_count` integer;--> statement-breakpoint
ALTER TABLE `stripe_connections` ADD `current_deadline` integer;--> statement-breakpoint
ALTER TABLE `stripe_connections` ADD `health_updated_at` integer;