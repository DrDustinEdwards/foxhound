ALTER TABLE `accounts` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `customer_context` ADD `currency` text;--> statement-breakpoint
CREATE INDEX `win_back_steps_account_idx` ON `win_back_steps` (`account_id`);