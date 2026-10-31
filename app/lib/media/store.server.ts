import { and, desc, eq, gt, inArray, lte, max, sql } from "drizzle-orm";

import { media, mediaChanges, mediaRevisions, type Db } from "~/db";

// The media index in D1 (app/db/schema/media.ts): the one module that reads and
// writes the three media tables. Every write to a file's own row goes through
// writeMediaAtRev, which moves `rev` in the statement that checks it.

export type MediaRow = typeof media.$inferSelect;
export type MediaRevisionRow = typeof mediaRevisions.$inferSelect;
export type MediaFields = Partial<Omit<MediaRow, "key" | "rev">>;

export type MediaWrite = { ok: true; rev: number } | { ok: false; reason: "missing" } | { ok: false; reason: "stale"; rev: number };

/** D1 binds at most 100 parameters to a statement. */
const IN_CHUNK = 90;

export async function mediaRow(db: Db, key: string): Promise<MediaRow | null> {
  const rows = await db.select().from(media).where(eq(media.key, key)).limit(1);
  return rows[0] ?? null;
}

export async function mediaRowsByKey(db: Db, keys: readonly string[]): Promise<MediaRow[]> {
  const rows: MediaRow[] = [];
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    rows.push(...(await db.select().from(media).where(inArray(media.key, keys.slice(i, i + IN_CHUNK)))));
  }
  return rows;
}

/** Every file, newest upload first. The library is a blog's pictures, so the
 *  list filters and sorts in memory over one read. */
export function allMediaRows(db: Db): Promise<MediaRow[]> {
  return db.select().from(media).orderBy(desc(media.uploadedAt), media.key);
}

/** The file holding these bytes now, or the one that was uploaded with them and
 *  changed at upload (converted, shrunk or its location taken out), so sending
 *  the same camera file again is a duplicate too. */
export async function mediaRowByHash(db: Db, sha256: string): Promise<MediaRow | null> {
  const rows = await db.select().from(media).where(eq(media.sha256, sha256)).orderBy(media.uploadedAt).limit(1);
  if (rows[0]) return rows[0];
  const sent = await db
    .select({ key: mediaRevisions.mediaKey })
    .from(mediaRevisions)
    .where(and(eq(mediaRevisions.sha256, sha256), inArray(mediaRevisions.reason, ["upload", "import"])))
    .limit(1);
  return sent[0] ? mediaRow(db, sent[0].key) : null;
}

export async function insertMediaRow(db: Db, row: typeof media.$inferInsert): Promise<void> {
  await db.insert(media).values(row);
}

/**
 * Writes `fields` and moves the version, only while the row is at
 * `expectedRev` (any rev when it is undefined, for a write the upload itself
 * makes). One statement, so two writers can never both pass the check.
 */
export async function writeMediaAtRev(db: Db, key: string, fields: MediaFields, expectedRev?: number): Promise<MediaWrite> {
  const where = expectedRev === undefined ? eq(media.key, key) : and(eq(media.key, key), eq(media.rev, expectedRev));
  const written = await db
    .update(media)
    .set({ ...fields, rev: sql`${media.rev} + 1` })
    .where(where)
    .returning({ rev: media.rev });
  if (written[0]) return { ok: true, rev: written[0].rev };
  const now = await mediaRow(db, key);
  return now ? { ok: false, reason: "stale", rev: now.rev } : { ok: false, reason: "missing" };
}

/** Removes the row only if it is still at `rev`, so a write that landed while
 *  the delete was checked keeps the file. */
export async function deleteMediaRowAtRev(db: Db, key: string, rev: number): Promise<boolean> {
  const gone = await db
    .delete(media)
    .where(and(eq(media.key, key), eq(media.rev, rev)))
    .returning({ key: media.key });
  return gone.length > 0;
}

// ---------- byte history

/** A file's revisions, newest first. */
export function revisionsOf(db: Db, key: string): Promise<MediaRevisionRow[]> {
  return db.select().from(mediaRevisions).where(eq(mediaRevisions.mediaKey, key)).orderBy(desc(mediaRevisions.id));
}

export async function addRevision(db: Db, row: Omit<typeof mediaRevisions.$inferInsert, "id">): Promise<number> {
  const added = await db.insert(mediaRevisions).values(row).returning({ id: mediaRevisions.id });
  return added[0]!.id;
}

/** Records where a revision's bytes were kept once newer bytes replaced them. */
export async function keepRevision(db: Db, id: number, copyKey: string): Promise<void> {
  await db.update(mediaRevisions).set({ copyKey }).where(eq(mediaRevisions.id, id));
}

export async function deleteRevisionsOf(db: Db, key: string): Promise<void> {
  await db.delete(mediaRevisions).where(eq(mediaRevisions.mediaKey, key));
}

// ---------- the change log (written by the triggers in migration 0059)

/** The newest change's number, 0 before any. */
export async function mediaChangeCursor(db: Db): Promise<number> {
  const rows = await db.select({ seq: max(mediaChanges.seq) }).from(mediaChanges);
  return rows[0]?.seq ?? 0;
}

/** Each key changed after `from` and at or before `head`, once, at its latest
 *  change, oldest first: at most `limit + 1`, so the caller knows whether more wait. */
export async function mediaChangedSince(db: Db, from: number, head: number, limit: number): Promise<Array<{ key: string; seq: number }>> {
  const latest = max(mediaChanges.seq);
  const rows = await db
    .select({ key: mediaChanges.mediaKey, seq: latest })
    .from(mediaChanges)
    .where(and(gt(mediaChanges.seq, from), lte(mediaChanges.seq, head)))
    .groupBy(mediaChanges.mediaKey)
    .orderBy(latest)
    .limit(limit + 1);
  return rows.map((r) => ({ key: r.key, seq: r.seq ?? 0 }));
}
