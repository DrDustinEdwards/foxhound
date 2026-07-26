ALTER TABLE `billing_invoices` ADD `charge_attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_invoices` ADD `last_charge_attempt_at` integer;