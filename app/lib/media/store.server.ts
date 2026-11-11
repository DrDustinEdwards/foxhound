import type {
  MediaLibraryStore,
  MediaRecord,
  MediaRecordFields,
  MediaRevisionRecord,
  MediaRecordWrite,
} from "@dustinedwards/site-api";
import { and, asc, desc, eq, gt, inArray, lte, max, notExists, sql } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";

import { media, mediaChanges, mediaRevisions, type Db } from "~/db";

// The media index in D1 (app/db/schema/media.ts): the one module that reads and
// writes the three media tables. `mediaStore` is site-api's MediaLibraryStore
// over them, mapping only: the columns keep their own types (times as ms
// integers, tags as JSON), and the library (site-api's mediaLibrary) owns every
// rule. The page and the media route read rows through mediaRow and
// mediaRowsByKey.

export type MediaRow = typeof media.$inferSelect;
type MediaRevisionRow = typeof mediaRevisions.$inferSelect;
type MediaFields = Partial<Omit<MediaRow, "key" | "rev">>;

export async function mediaRow(db: Db, key: string): Promise<MediaRow | null> {
  const rows = await db.select().from(media).where(eq(media.key, key)).limit(1);
  return rows[0] ?? null;
}

export async function mediaRowsByKey(db: Db, keys: readonly string[]): Promise<MediaRow[]> {
  if (keys.length === 0) return [];
  return db.select().from(media).where(inList(media.key, keys));
}

const iso = (at: Date) => at.toISOString();

function recordOf(row: MediaRow): MediaRecord {
  return {
    key: row.key,
    rev: row.rev,
    filename: row.filename,
    contentType: row.contentType,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    alt: row.alt,
    caption: row.caption,
    tags: row.tags,
    focus: row.focus,
    credit: row.credit,
    license: row.license,
    sourceUrl: row.sourceUrl,
    licenseExpires: row.licenseExpires,
    takenAt: row.takenAt,
    placeholder: row.placeholder,
    color: row.color,
    uploadedAt: iso(row.uploadedAt),
    trashedAt: row.trashedAt ? iso(row.trashedAt) : null,
  };
}

/** The record fields stored as they are. */
const PLAIN = [
  "filename",
  "contentType",
  "bytes",
  "width",
  "height",
  "alt",
  "caption",
  "tags",
  "focus",
  "credit",
  "license",
  "sourceUrl",
  "licenseExpires",
  "takenAt",
  "placeholder",
  "color",
] as const satisfies ReadonlyArray<keyof MediaRecordFields & keyof MediaFields>;

/** A write's fields as columns: ISO times as Dates; a field with no column here is dropped. */
function fieldsOf(fields: MediaRecordFields): MediaFields {
  const { uploadedAt, trashedAt, sha256 } = fields;
  return {
    ...Object.fromEntries(
      PLAIN.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]]),
    ),
    ...(uploadedAt !== undefined ? { uploadedAt: new Date(uploadedAt) } : {}),
    ...(trashedAt !== undefined
      ? { trashedAt: trashedAt === null ? null : new Date(trashedAt) }
      : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}

function revisionOf(row: MediaRevisionRow): MediaRevisionRecord {
  return {
    id: row.id,
    at: iso(row.at),
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    reason: row.reason as MediaRevisionRecord["reason"],
    sha256: row.sha256 || null,
    copyKey: row.copyKey,
  };
}

/** site-api's media library store over migration 0059's tables. */
export function mediaStore(db: Db): MediaLibraryStore {
  const record = async (key: string) => {
    const row = await mediaRow(db, key);
    return row ? recordOf(row) : null;
  };

  return {
    record,

    records: async (keys) => (await mediaRowsByKey(db, keys)).map(recordOf),

    all: async () =>
      (await db.select().from(media).orderBy(desc(media.uploadedAt), media.key)).map(recordOf),

    async byHash(sha256) {
      const [current] = await db
        .select()
        .from(media)
        .where(eq(media.sha256, sha256))
        .orderBy(asc(media.uploadedAt), asc(media.key))
        .limit(1);
      if (current) return recordOf(current);
      const [sent] = await db
        .select({ key: mediaRevisions.mediaKey })
        .from(mediaRevisions)
        .where(
          and(
            eq(mediaRevisions.sha256, sha256),
            inArray(mediaRevisions.reason, ["upload", "import"]),
          ),
        )
        .orderBy(asc(mediaRevisions.id))
        .limit(1);
      return sent ? record(sent.key) : null;
    },

    async insert(input) {
      const { key, filename, contentType, bytes, sha256, ...rest } = input;
      if (!sha256) throw new Error(`${key} has no hash to store`);
      await db.insert(media).values({
        ...fieldsOf(rest),
        key,
        filename,
        contentType,
        bytes,
        sha256,
        uploadedAt: new Date(input.uploadedAt),
      });
    },

    // One statement, so two writers can never both pass the check.
    async writeAtRev(key, fields, expectedRev): Promise<MediaRecordWrite> {
      const [row] = await db
        .update(media)
        .set({ ...fieldsOf(fields), rev: sql`${media.rev} + 1` })
        .where(and(eq(media.key, key), eq(media.rev, expectedRev)))
        .returning();
      if (row) return { ok: true, record: recordOf(row) };
      const now = await mediaRow(db, key);
      return now ? { ok: false, reason: "stale", rev: now.rev } : { ok: false, reason: "missing" };
    },

    async follow(key, fields) {
      const set = fieldsOf(fields);
      const [row] =
        Object.keys(set).length === 0
          ? [await mediaRow(db, key)]
          : await db.update(media).set(set).where(eq(media.key, key)).returning();
      if (!row) throw new Error(`${key} changed its bytes, but its row is gone`);
      return recordOf(row);
    },

    async addRevision(key, revision) {
      const [added] = await db
        .insert(mediaRevisions)
        .values({
          ...revision,
          mediaKey: key,
          at: new Date(revision.at),
          sha256: revision.sha256 ?? "",
        })
        .returning({ id: mediaRevisions.id });
      return added!.id;
    },

    revisions: async (key, limit = 100) =>
      (
        await db
          .select()
          .from(mediaRevisions)
          .where(eq(mediaRevisions.mediaKey, key))
          .orderBy(desc(mediaRevisions.id))
          .limit(limit)
      ).map(revisionOf),

    async keepCopy(revisionId, copyKey) {
      await db.update(mediaRevisions).set({ copyKey }).where(eq(mediaRevisions.id, revisionId));
    },

    // Only at the rev the caller saw, so a write that landed meanwhile keeps the file; the revisions go only with the row.
    async remove(key, rev) {
      const [gone] = await db.batch([
        db
          .delete(media)
          .where(and(eq(media.key, key), eq(media.rev, rev)))
          .returning({ key: media.key }),
        db
          .delete(mediaRevisions)
          .where(
            and(
              eq(mediaRevisions.mediaKey, key),
              notExists(db.select({ key: media.key }).from(media).where(eq(media.key, key))),
            ),
          ),
      ]);
      if (gone.length > 0) return "removed";
      return (await mediaRow(db, key)) ? "stale" : "missing";
    },

    // The change log, written by the triggers in migration 0059.
    async changeCursor() {
      const rows = await db.select({ seq: max(mediaChanges.seq) }).from(mediaChanges);
      return rows[0]?.seq ?? 0;
    },

    async changedSince(from, head, limit) {
      const latest = max(mediaChanges.seq);
      const rows = await db
        .select({ key: mediaChanges.mediaKey, seq: latest })
        .from(mediaChanges)
        .where(and(gt(mediaChanges.seq, from), lte(mediaChanges.seq, head)))
        .groupBy(mediaChanges.mediaKey)
        .orderBy(latest)
        .limit(limit + 1);
      return rows.map((r) => ({ key: r.key, seq: r.seq ?? 0 }));
    },
  };
}
