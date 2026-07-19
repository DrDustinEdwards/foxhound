import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import {
  getAllPublishedPosts,
  getFeaturedPost,
  getNextPost,
  getPostBySlug,
  getPostLinks,
  getPostsBySlug,
  getPreviousPost,
  listPublishedPosts,
  resolvePostLink,
} from "~/lib/blog/queries.server";

// A drizzle-orm/sqlite-proxy handle backed by a callback that always
// returns zero rows: this is the realistic pre-STOP-A state (blog_posts
// exists but is empty), and every public blog loader must degrade to an
// empty array or null rather than throwing. Cast to Db (the D1-flavored
// drizzle type the app's query modules take) because the proxy driver and
// the D1 driver differ only in their internal result-row generic, not in
// the query-builder surface these tests exercise.
function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

describe("blog queries against an empty blog_posts table", () => {
  it("listPublishedPosts returns []", async () => {
    expect(await listPublishedPosts(emptyDb())).toEqual([]);
  });

  it("listPublishedPosts with a limit still returns []", async () => {
    expect(await listPublishedPosts(emptyDb(), 8)).toEqual([]);
  });

  it("getAllPublishedPosts returns []", async () => {
    expect(await getAllPublishedPosts(emptyDb())).toEqual([]);
  });

  it("getFeaturedPost returns null", async () => {
    expect(await getFeaturedPost(emptyDb())).toBeNull();
  });

  it("getPostsBySlug short-circuits to [] without querying when slugs is empty", async () => {
    expect(await getPostsBySlug(emptyDb(), [])).toEqual([]);
  });

  it("getPostsBySlug returns [] when nothing matches", async () => {
    expect(await getPostsBySlug(emptyDb(), ["some-slug"])).toEqual([]);
  });

  it("getPostBySlug returns null", async () => {
    expect(await getPostBySlug(emptyDb(), "some-slug")).toBeNull();
  });

  it("getPreviousPost and getNextPost return null", async () => {
    const db = emptyDb();
    expect(await getPreviousPost(db, new Date(), "id")).toBeNull();
    expect(await getNextPost(db, new Date(), "id")).toBeNull();
  });

  it("getPostLinks returns []", async () => {
    expect(await getPostLinks(emptyDb(), "post-id")).toEqual([]);
  });

  it("resolvePostLink returns null", async () => {
    expect(await resolvePostLink(emptyDb(), "some-slug")).toBeNull();
  });
});
