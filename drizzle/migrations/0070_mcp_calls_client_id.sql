-- The OAuth client each merchant MCP call's key was issued to (area 11, L3),
-- beside the key id. Additive: earlier rows and keys made in Settings read null.
ALTER TABLE `mcp_calls` ADD `client_id` text;
