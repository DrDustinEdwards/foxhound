CREATE TABLE `oauth_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_authorization_codes_code_hash_uq` ON `oauth_authorization_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_authorization_codes_account_idx` ON `oauth_authorization_codes` (`account_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`code_id` text NOT NULL,
	`refresh_hash` text NOT NULL,
	`previous_refresh_hash` text,
	`refresh_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_hash_uq` ON `oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_previous_refresh_hash_idx` ON `oauth_grants` (`previous_refresh_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_code_idx` ON `oauth_grants` (`code_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_api_key_idx` ON `oauth_grants` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_account_idx` ON `oauth_grants` (`account_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `expires_at` integer;