-- The blog's media library (site-api v0.13 media group, Carrel's media page).
-- ADDITIVE: three new tables, three indexes and three triggers. No existing
-- table or row is touched, so no money table is involved (CLAUDE.md hard rule 5 does not
-- apply: nothing is recreated). The tables come from app/db/schema/media.ts
-- through drizzle-kit; the triggers are written by hand below, since Drizzle
-- does not model them.
CREATE TABLE `media` (
	`key` text PRIMARY KEY NOT NULL,
	`filename` text,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`alt` text DEFAULT '' NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`focus` text,
	`credit` text DEFAULT '' NOT NULL,
	`license` text DEFAULT '' NOT NULL,
	`source_url` text,
	`license_expires` text,
	`taken_at` text,
	`trashed_at` integer,
	`uploaded_at` integer NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_sha256_idx` ON `media` (`sha256`);--> statement-breakpoint
CREATE TABLE `media_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_changes_key_idx` ON `media_changes` (`media_key`,`seq`);--> statement-breakpoint
CREATE TABLE `media_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_key` text NOT NULL,
	`at` integer NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`reason` text NOT NULL,
	`sha256` text NOT NULL,
	`copy_key` text
);
--> statement-breakpoint
CREATE INDEX `media_revisions_key_idx` ON `media_revisions` (`media_key`,`id`);--> statement-breakpoint
-- Every change to a media row, in order: what site-api's changedSince answers
-- from. Triggers rather than a write in each writer, so no writer can forget.
CREATE TRIGGER `media_changes_ai` AFTER INSERT ON `media` BEGIN
  INSERT INTO `media_changes` (`media_key`) VALUES (NEW.`key`);
END;
--> statement-breakpoint
CREATE TRIGGER `media_changes_au` AFTER UPDATE ON `media` BEGIN
  INSERT INTO `media_changes` (`media_key`) VALUES (NEW.`key`);
END;
--> statement-breakpoint
CREATE TRIGGER `media_changes_ad` AFTER DELETE ON `media` BEGIN
  INSERT INTO `media_changes` (`media_key`) VALUES (OLD.`key`);
END;
