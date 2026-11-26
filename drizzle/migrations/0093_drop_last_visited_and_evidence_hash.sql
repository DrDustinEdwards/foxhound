-- contract: drops three columns nothing reads or writes since #879. accounts.last_visited_product (the app shell's
-- nav now comes from the path alone; 2 of 5 production accounts held a value), accounts.last_visited_path (never
-- written; 0 of 5 held a value) and predictions.band_evidence_hash (written and never read; 106 of 106 rows held a
-- value). Counted 2026-11-26. No column is indexed, no table is recreated (plain DROP COLUMN) and no money table is
-- touched. The deploy refuses a contract migration, so it is applied by hand after a D1 Time Travel bookmark.
ALTER TABLE `accounts` DROP COLUMN `last_visited_path`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `last_visited_product`;--> statement-breakpoint
ALTER TABLE `predictions` DROP COLUMN `band_evidence_hash`;