import { describe, expect, it } from "vitest";

import { page404Key, PAGE_404_PATH_MAX } from "~/lib/errors/page-404.server";


// J21, ruling 37: page_404_daily had three readers (the admin API's /health
// top_404s_7d, the operations table count, the 365-day retention sweep) and no
// writer, so /health reported an empty list on a site that was serving 404s.
// These run the real upsert against the committed migrations, so the unique
// index (day, path) the increment depends on is the one production has.

const NOON = new Date("2026-10-14T12:34:56.789Z");
const MIDNIGHT = new Date("2026-10-14T00:00:00.000Z");


describe("page404Key", () => {
  it("buckets by UTC midnight of now", () => {
    expect(page404Key(new URL("https://example.com/missing"), NOON).day).toEqual(MIDNIGHT);
  });

  it("caps a long path at PAGE_404_PATH_MAX", () => {
    const key = page404Key(new URL(`https://example.com/${"a".repeat(2000)}`), NOON);
    expect(key.path).toHaveLength(PAGE_404_PATH_MAX);
    expect(key.path.startsWith("/aaa")).toBe(true);
  });
});
