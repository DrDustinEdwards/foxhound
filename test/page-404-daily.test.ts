import { describe, expect, it } from "vitest";

import { page404Daily } from "~/db/schema";
import { page404Key, PAGE_404_PATH_MAX, recordPage404 } from "~/lib/errors/page-404.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J21, ruling 37: page_404_daily had three readers (the admin API's /health
// top_404s_7d, the operations table count, the 365-day retention sweep) and no
// writer, so /health reported an empty list on a site that was serving 404s.
// These run the real upsert against the committed migrations, so the unique
// index (day, path) the increment depends on is the one production has.

const NOON = new Date("2026-10-14T12:34:56.789Z");
const MIDNIGHT = new Date("2026-10-14T00:00:00.000Z");

function rows(db: ReturnType<typeof createInMemoryDb>["db"]) {
  return db
    .select({ day: page404Daily.day, path: page404Daily.path, hits: page404Daily.hitCount })
    .from(page404Daily)
    .orderBy(page404Daily.day, page404Daily.path);
}

describe("page404Key", () => {
  it("buckets by UTC midnight of now", () => {
    expect(page404Key(new URL("https://example.com/missing"), NOON).day).toEqual(MIDNIGHT);
  });

  it("keeps the pathname and drops the query string, which can carry a token", () => {
    const key = page404Key(new URL("https://example.com/reset?token=secret#frag"), NOON);
    expect(key.path).toBe("/reset");
  });

  it("caps a long path at PAGE_404_PATH_MAX", () => {
    const key = page404Key(new URL(`https://example.com/${"a".repeat(2000)}`), NOON);
    expect(key.path).toHaveLength(PAGE_404_PATH_MAX);
    expect(key.path.startsWith("/aaa")).toBe(true);
  });
});

describe("recordPage404", () => {
  it("inserts a row with one hit on the first 404 of a day", async () => {
    const { db } = createInMemoryDb();
    await recordPage404(db, new URL("https://example.com/missing"), NOON);
    expect(await rows(db)).toEqual([{ day: MIDNIGHT, path: "/missing", hits: 1 }]);
  });

  it("increments the same day and path rather than adding a row", async () => {
    const { db } = createInMemoryDb();
    await recordPage404(db, new URL("https://example.com/missing"), NOON);
    await recordPage404(db, new URL("https://example.com/missing?utm=x"), new Date("2026-10-14T23:59:59.999Z"));
    expect(await rows(db)).toEqual([{ day: MIDNIGHT, path: "/missing", hits: 2 }]);
  });

  it("starts a new row for a different day or a different path", async () => {
    const { db } = createInMemoryDb();
    await recordPage404(db, new URL("https://example.com/missing"), NOON);
    await recordPage404(db, new URL("https://example.com/missing"), new Date("2026-10-15T00:00:00.000Z"));
    await recordPage404(db, new URL("https://example.com/other"), NOON);
    expect(await rows(db)).toEqual([
      { day: MIDNIGHT, path: "/missing", hits: 1 },
      { day: MIDNIGHT, path: "/other", hits: 1 },
      { day: new Date("2026-10-15T00:00:00.000Z"), path: "/missing", hits: 1 },
    ]);
  });

  it("stores the capped path, so two long paths sharing a prefix share a row", async () => {
    const { db } = createInMemoryDb();
    const prefix = `https://example.com/${"b".repeat(PAGE_404_PATH_MAX)}`;
    await recordPage404(db, new URL(`${prefix}/one`), NOON);
    await recordPage404(db, new URL(`${prefix}/two`), NOON);
    const stored = await rows(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.path).toHaveLength(PAGE_404_PATH_MAX);
    expect(stored[0]!.hits).toBe(2);
  });
});
