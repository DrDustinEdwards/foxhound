-- The merchant MCP's read and write split (merchant.read, merchant.write).
-- An OAuth grant made before it held the one scope "merchant", which now reads
-- as merchant.read: the client reconnects and the owner ticks "Allow changes"
-- to write again. A key made in Settings keeps what it could do, both: the
-- owner made it by hand, signed in.
ALTER TABLE `api_keys` ADD `scopes` text;--> statement-breakpoint
ALTER TABLE `oauth_authorization_codes` ADD `scopes` text;--> statement-breakpoint
UPDATE `api_keys` SET `scopes` = '["merchant.read"]' WHERE `id` IN (SELECT `api_key_id` FROM `oauth_grants`);--> statement-breakpoint
UPDATE `api_keys` SET `scopes` = '["merchant.read","merchant.write"]' WHERE `scope` = 'mcp_merchant' AND `scopes` IS NULL;
