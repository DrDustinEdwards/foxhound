CREATE TABLE `mcp_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`tool` text NOT NULL,
	`arguments` text,
	`outcome` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_calls_account_idx` ON `mcp_calls` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `mcp_calls_no_update` BEFORE UPDATE ON `mcp_calls`
BEGIN
	SELECT RAISE(ABORT, 'mcp_calls is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `mcp_calls_no_delete` BEFORE DELETE ON `mcp_calls`
BEGIN
	SELECT RAISE(ABORT, 'mcp_calls is append-only');
END;
