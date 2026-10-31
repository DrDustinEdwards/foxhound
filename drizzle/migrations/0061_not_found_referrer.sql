DROP INDEX `page_404_daily_day_path_uq`;--> statement-breakpoint
ALTER TABLE `page_404_daily` ADD `referrer_host` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `page_404_daily` ADD `kind` text DEFAULT 'page' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `page_404_daily_day_path_referrer_uq` ON `page_404_daily` (`day`,`path`,`referrer_host`);