CREATE TABLE `mcp_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`tool` text NOT NULL,
	`fields` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_writes_account_idx` ON `mcp_writes` (`account_id`);