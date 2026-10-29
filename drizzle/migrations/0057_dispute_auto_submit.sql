ALTER TABLE `dispute_approvals` ADD `standing_opt_in_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_by_user_id` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_by_email` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `dispute_auto_submit_at` integer;