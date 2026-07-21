ALTER TABLE `accounts` ADD `cancelled_at` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_billing_line_items` (
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
	CONSTRAINT "billing_line_items_type_ck" CHECK("__new_billing_line_items"."type" in ('recovery_fee', 'dispute_fee', 'subscription', 'adjustment')),
	CONSTRAINT "billing_line_items_adjustment_audit_ck" CHECK("__new_billing_line_items"."type" != 'adjustment' or "__new_billing_line_items"."admin_audit_log_id" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_billing_line_items`("id", "invoice_id", "account_id", "type", "currency", "amount_cents", "fee_cents", "recovered_payment_id", "dispute_id", "admin_audit_log_id", "description", "created_at") SELECT "id", "invoice_id", "account_id", "type", "currency", "amount_cents", "fee_cents", "recovered_payment_id", "dispute_id", "admin_audit_log_id", "description", "created_at" FROM `billing_line_items`;--> statement-breakpoint
DROP TABLE `billing_line_items`;--> statement-breakpoint
ALTER TABLE `__new_billing_line_items` RENAME TO `billing_line_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `billing_line_items_invoice_idx` ON `billing_line_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `billing_line_items_account_idx` ON `billing_line_items` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_line_items_recovery_uq` ON `billing_line_items` (`recovered_payment_id`) WHERE "billing_line_items"."recovered_payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_line_items_dispute_uq` ON `billing_line_items` (`dispute_id`) WHERE "billing_line_items"."dispute_id" is not null;