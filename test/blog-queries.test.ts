import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { blogPosts } from "~/db";
import {
  getPublishedPostsByTag,
} from "~/lib/blog/queries.server";
import { createInMemoryDb } from "./helpers/inmemory-db";

// A drizzle-orm/sqlite-proxy handle backed by a callback that always
// returns zero rows: this is the realistic pre-STOP-A state (blog_posts
// exists but is empty), and every public blog loader must degrade to an
// empty array or null rather than throwing. Cast to Db (the D1-flavored
// drizzle type the app's query modules take) because the proxy driver and
// the D1 driver differ only in their internal result-row generic, not in
// the query-builder surface these tests exercise.

describe("getPublishedPostsByTag against a real in-memory SQLite (perf-audit fix, foxhound-audit-perf.md M-2)", () => {
  // Filtering moved from JS (fetch every post's full body, filter in memory)
  // to a SQL json_each EXISTS predicate against the JSON-encoded tags
  // column. Real SQLite (via better-sqlite3, migrations applied verbatim),
  // not the empty-rows proxy above, so this proves the raw sql`` template
  // actually executes, not just that it type-checks.
  function seedPost(db: Db, overrides: { id: string; slug: string; tags: string[]; published?: boolean }) {
    const now = new Date();
    return db.insert(blogPosts).values({
      id: overrides.id,
      slug: overrides.slug,
      title: overrides.slug,
      excerpt: overrides.slug,
      body: "word ".repeat(10),
      published: overrides.published ?? true,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      author: "Foxhound",
      tags: overrides.tags,
      featured: false,
    });
  }

  it("returns only posts whose tags include the requested tag, disjoint tags stay separate", async () => {
    const { db } = createInMemoryDb();
    await seedPost(db, { id: "1", slug: "a", tags: ["payment-recovery"] });
    await seedPost(db, { id: "2", slug: "b", tags: ["disputes"] });
    await seedPost(db, { id: "3", slug: "c", tags: ["payment-recovery", "comparisons"] });

    const paymentRecovery = await getPublishedPostsByTag(db, "payment-recovery");
    expect(paymentRecovery.map((p) => p.slug).sort()).toEqual(["a", "c"]);

    const disputes = await getPublishedPostsByTag(db, "disputes");
    expect(disputes.map((p) => p.slug)).toEqual(["b"]);
  });

  it("a multi-tag post appears on every one of its own tag archives", async () => {
    const { db } = createInMemoryDb();
    await seedPost(db, { id: "1", slug: "c", tags: ["payment-recovery", "comparisons"] });

    expect((await getPublishedPostsByTag(db, "payment-recovery")).map((p) => p.slug)).toEqual(["c"]);
    expect((await getPublishedPostsByTag(db, "comparisons")).map((p) => p.slug)).toEqual(["c"]);
  });

  it("returns [] for a tag no published post carries", async () => {
    const { db } = createInMemoryDb();
    await seedPost(db, { id: "1", slug: "a", tags: ["payment-recovery"] });
    expect(await getPublishedPostsByTag(db, "saas-metrics")).toEqual([]);
  });

  it("excludes an unpublished post even if its tags match", async () => {
    const { db } = createInMemoryDb();
    await seedPost(db, { id: "1", slug: "draft", tags: ["payment-recovery"], published: false });
    expect(await getPublishedPostsByTag(db, "payment-recovery")).toEqual([]);
  });
});
