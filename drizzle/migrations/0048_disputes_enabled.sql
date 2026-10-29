-- The Disputes on/off switch (/settings/disputes, Recova's DisputesToggle).
-- Every existing account starts ON, as Recova activated Disputes on connect.
ALTER TABLE `accounts` ADD `disputes_enabled` integer DEFAULT true NOT NULL;
