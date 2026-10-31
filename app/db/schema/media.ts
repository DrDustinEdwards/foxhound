import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { json, ts } from "./columns";

// ============================================================================
// The blog's media library (global, no account: editorial pictures only)
// ============================================================================
//
// What Carrel uploads for blog posts (app/lib/carrel/media-adapter.server.ts).
// The bytes live in the MEDIA R2 bucket under the same key; this is the index
// site-api's media group answers from. No merchant data is ever stored here:
// the only writer is Carrel's site-api mount, and merchant dispute evidence
// stays in its own EVIDENCE bucket and tables.

export const media = sqliteTable(
  "media",
  {
    /** The R2 key and the site-api id, such as 2026/10/declines-chart-1a2b3c4d.png. */
    key: text("key").primaryKey(),
    /** The name it was uploaded with. */
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** SHA-256 of the current bytes, lower case hex: duplicates are exact bytes. */
    sha256: text("sha256").notNull(),
    alt: text("alt").notNull().default(""),
    caption: text("caption").notNull().default(""),
    tags: json<string[]>("tags").notNull().default([]),
    /** "XxY", each 0 to 1 (site-runtime ./image focusOf), or null. Also on the object's customMetadata. */
    focus: text("focus"),
    credit: text("credit").notNull().default(""),
    license: text("license").notNull().default(""),
    sourceUrl: text("source_url"),
    /** YYYY-MM-DD. */
    licenseExpires: text("license_expires"),
    /** As the picture's embedded metadata says, with an offset where it names one. */
    takenAt: text("taken_at"),
    /** A 16 px blurred WebP data: URI and the main color (#rrggbb), from site-api's prepareUpload for the current bytes. */
    placeholder: text("placeholder"),
    color: text("color"),
    trashedAt: ts("trashed_at"),
    uploadedAt: ts("uploaded_at").notNull(),
    /** Moved by every write in the statement that checks it, so a stale write is refused, never lost. */
    rev: integer("rev").notNull().default(0),
  },
  (t) => [index("media_sha256_idx").on(t.sha256)],
);

/** Every set of bytes a file has had, newest last. The earlier sets are kept in MEDIA under `copy_key`. */
export const mediaRevisions = sqliteTable(
  "media_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaKey: text("media_key").notNull(),
    at: ts("at").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** upload | import | replace | transform | resize | revert */
    reason: text("reason").notNull(),
    sha256: text("sha256").notNull(),
    /** Where these bytes were kept once newer ones replaced them; null while they are the current ones. */
    copyKey: text("copy_key"),
  },
  (t) => [index("media_revisions_key_idx").on(t.mediaKey, t.id)],
);

/** One row per change to a `media` row, written by triggers (migration 0059): what `changedSince` reads. */
export const mediaChanges = sqliteTable(
  "media_changes",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    mediaKey: text("media_key").notNull(),
  },
  (t) => [index("media_changes_key_idx").on(t.mediaKey, t.seq)],
);
