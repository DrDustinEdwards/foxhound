PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_alert_history` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text,
	`account_id` text NOT NULL,
	`metric` text NOT NULL,
	`threshold_value` real NOT NULL,
	`direction` text NOT NULL,
	`actual_value` real NOT NULL,
	`channel` text NOT NULL,
	`fired_at` integer NOT NULL,
	`notification_sent` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_alert_history`("id", "alert_id", "account_id", "metric", "threshold_value", "direction", "actual_value", "channel", "fired_at", "notification_sent") SELECT "id", "alert_id", "account_id", "metric", "threshold_value", "direction", "actual_value", "channel", "fired_at", "notification_sent" FROM `alert_history`;--> statement-breakpoint
DROP TABLE `alert_history`;--> statement-breakpoint
ALTER TABLE `__new_alert_history` RENAME TO `alert_history`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE INDEX `alert_history_account_idx` ON `alert_history` (`account_id`);--> statement-breakpoint
CREATE INDEX `alert_history_alert_idx` ON `alert_history` (`alert_id`);