CREATE TABLE `billing_exemption_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`ended_by_change_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `billing_exemption_periods_account_idx` ON `billing_exemption_periods` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_exemption_periods_open_uq` ON `billing_exemption_periods` (`account_id`) WHERE "billing_exemption_periods"."ended_at" is null;--> statement-breakpoint
-- Every account exempt today gets its open stretch, so ending the exemption later
-- closes a real row and forgives what came due meanwhile. The demo account never
-- bills (its id prefix) and needs none.
INSERT INTO `billing_exemption_periods` (`id`, `account_id`, `started_at`)
SELECT lower(hex(randomblob(16))), `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `accounts`
WHERE `billing_exempt` = 1 AND `id` NOT LIKE 'demo\_%' ESCAPE '\';
