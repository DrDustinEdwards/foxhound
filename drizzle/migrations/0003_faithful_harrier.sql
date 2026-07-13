DROP INDEX `email_suppressions_email_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_suppressions_email_uq` ON `email_suppressions` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `failed_payments_active_invoice_uq` ON `failed_payments` (`stripe_invoice_id`) WHERE "failed_payments"."status" = 'active';