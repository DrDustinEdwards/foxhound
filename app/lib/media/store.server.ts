import { eq } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";

import { media, type Db } from "~/db";

// The blog's reads of the media index (app/db/schema/media.ts, site-api's
// standard tables, which only its d1MediaStore writes: app/lib/carrel/media-adapter.server.ts).
// The page and the media route read rows through mediaRow and mediaRowsByKey.

export type MediaRow = typeof media.$inferSelect;

export async function mediaRow(db: Db, key: string): Promise<MediaRow | null> {
  const rows = await db.select().from(media).where(eq(media.key, key)).limit(1);
  return rows[0] ?? null;
}

export async function mediaRowsByKey(db: Db, keys: readonly string[]): Promise<MediaRow[]> {
  if (keys.length === 0) return [];
  return db.select().from(media).where(inList(media.key, keys));
}
