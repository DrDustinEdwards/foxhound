-- contract: the blog's media index becomes site-api's standard tables (MEDIA_LIBRARY_SQL), which its
-- d1MediaStore writes in place of Foxhound's own store. media and media_revisions are rebuilt with
-- their times as ISO 8601 UTC text (they were epoch ms integers) and the standard index names; the
-- extra media_changes index goes. Every row is copied, times converted. No money table and no
-- foreign key is involved (CLAUDE.md hard rule 5). Hand-run with a Time Travel bookmark first:
--   npx wrangler d1 migrations apply foxhound --remote
DROP TRIGGER `media_changes_ai`;--> statement-breakpoint
DROP TRIGGER `media_changes_au`;--> statement-breakpoint
DROP TRIGGER `media_changes_ad`;--> statement-breakpoint
CREATE TABLE `__new_media` (
  key TEXT PRIMARY KEY NOT NULL,
  filename TEXT,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  focus TEXT,
  credit TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  license_expires TEXT,
  taken_at TEXT,
  uploaded_at TEXT NOT NULL,
  trashed_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  placeholder TEXT,
  color TEXT
);
--> statement-breakpoint
INSERT INTO `__new_media` (key, filename, content_type, bytes, width, height, sha256, alt, caption, tags, focus, credit, license, source_url, license_expires, taken_at, uploaded_at, trashed_at, rev, placeholder, color)
SELECT key, filename, content_type, bytes, width, height, sha256, alt, caption, tags, focus, credit, license, source_url, license_expires, taken_at,
  strftime('%Y-%m-%dT%H:%M:%S', uploaded_at / 1000, 'unixepoch') || '.' || printf('%03d', uploaded_at % 1000) || 'Z',
  CASE WHEN trashed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%S', trashed_at / 1000, 'unixepoch') || '.' || printf('%03d', trashed_at % 1000) || 'Z' END,
  rev, placeholder, color
FROM `media`;
--> statement-breakpoint
DROP TABLE `media`;--> statement-breakpoint
ALTER TABLE `__new_media` RENAME TO `media`;--> statement-breakpoint
CREATE INDEX media_sha256 ON media (sha256);--> statement-breakpoint
CREATE TABLE `__new_media_revisions` (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_key TEXT NOT NULL,
  at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  reason TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  copy_key TEXT
);
--> statement-breakpoint
INSERT INTO `__new_media_revisions` (id, media_key, at, bytes, width, height, reason, sha256, copy_key)
SELECT id, media_key, strftime('%Y-%m-%dT%H:%M:%S', at / 1000, 'unixepoch') || '.' || printf('%03d', at % 1000) || 'Z',
  bytes, width, height, reason, sha256, copy_key
FROM `media_revisions`;
--> statement-breakpoint
DROP TABLE `media_revisions`;--> statement-breakpoint
ALTER TABLE `__new_media_revisions` RENAME TO `media_revisions`;--> statement-breakpoint
CREATE INDEX media_revisions_key ON media_revisions (media_key, id);--> statement-breakpoint
DROP INDEX `media_changes_key_idx`;--> statement-breakpoint
CREATE TRIGGER media_changes_insert AFTER INSERT ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (NEW.key);
END;
--> statement-breakpoint
CREATE TRIGGER media_changes_update AFTER UPDATE ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (NEW.key);
END;
--> statement-breakpoint
CREATE TRIGGER media_changes_delete AFTER DELETE ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (OLD.key);
END;
