import { sql } from "drizzle-orm";

import type { Db } from "~/db";
import { page404Daily } from "~/db/schema";
import { DAY_MS } from "~/lib/constants";

// The writer for page_404_daily (ruling 37, job J21). The table had three
// readers and no writer: the admin API's /health top_404s_7d, the operations
// table count and the 365-day retention sweep all read an empty table while the
// site served 404s.
//
// LEGACY'S SHAPE IS NOT KEPT, ON PURPOSE. Recova's app/not-found.tsx inserted
// one page_404s row per hit with the path, the referrer and the user agent.
// Foxhound's table is a daily aggregate per path (docs/schema/legacy-map.md,
// page_404s: REDESIGN), so the referrer and the user agent are not stored at
// all: a count per path per day is what the readers above use, and a raw row
// per hit carrying a visitor's user agent is data with no reader.

/** The longest path stored. A crawler probing for exploits sends very long
 *  URLs, and each distinct one would otherwise be its own row of that size. */
export const PAGE_404_PATH_MAX = 512;

/** The row a 404 counts against: UTC midnight of `now`, and the URL's pathname
 *  capped at PAGE_404_PATH_MAX. The query string is never part of the key: a
 *  query can carry a token (a reset link, a magic link, an unsubscribe token),
 *  and this table is read on /health by people who should never see one. */
export function page404Key(url: URL, now: Date): { day: Date; path: string } {
  const day = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  return { day, path: url.pathname.slice(0, PAGE_404_PATH_MAX) };
}

/** Counts one 404 for `url` on `now`'s UTC day: the first of the day inserts a
 *  row with one hit, every later one increments it. One statement, so two
 *  concurrent 404s on the same path cannot both insert or lose a hit; the
 *  unique index (day, path) is what makes the conflict fire. */
export async function recordPage404(db: Db, url: URL, now: Date): Promise<void> {
  const { day, path } = page404Key(url, now);
  await db
    .insert(page404Daily)
    .values({ day, path, hitCount: 1 })
    .onConflictDoUpdate({
      target: [page404Daily.day, page404Daily.path],
      set: { hitCount: sql`${page404Daily.hitCount} + 1` },
    });
}
