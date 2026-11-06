-- The rough place each session was signed in from (session.location, a Better
-- Auth additional field in app/lib/auth/options.ts), shown in the signed-in
-- devices list on /settings/account. Additive: existing sessions read null.
ALTER TABLE `session` ADD `location` text;
