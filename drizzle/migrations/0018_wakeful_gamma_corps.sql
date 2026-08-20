DROP INDEX `account_members_one_active_per_user_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_members_user_account_active_uq` ON `account_members` (`user_id`,`account_id`) WHERE "account_members"."status" = 'active';--> statement-breakpoint
ALTER TABLE `session` ADD `active_account_id` text;