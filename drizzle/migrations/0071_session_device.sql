-- site-runtime v0.59.0 session details (signInOptions sessionDetails, app/lib/auth/auth.server.ts):
-- SESSION_DETAILS_SQL less `location`, which 0069 added in the same shape, and
-- AUTH_EVENTS_DEVICE_SQL. The device id is the random value in site-runtime's
-- signed device cookie, kept on each session and on each sign-in's auth_events
-- row, so the new-device notice tells two browsers of the same make apart.
-- Additive: existing rows read null.
ALTER TABLE `session` ADD `device_id` text;
--> statement-breakpoint
ALTER TABLE auth_events ADD COLUMN device_id TEXT;
