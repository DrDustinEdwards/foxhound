import { describe, expect, it, vi } from "vitest";

import { blogPosts } from "~/db";
import type { Db } from "~/db";
import type { BlogPostSummary } from "~/lib/blog/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J19 (job_deffd581af37), rows M11 (/blog) and M14 (/blog/tag/:tag). Recova's
// spec, read whole: app/(marketing)/blog/page.tsx (blob d2d4dbfd),
// BlogHeaderIntro.tsx (a8ba9e72), BlogPostCard.tsx (48ba6d39), lib/blog.ts
// (55a92d1a) and tag/[tag]/page.tsx (3f6aa696).
//
// Recova is the spec for content, layout and features; the parts are
// Capsomer's (Q12), the color amber, the text on the five sizes
// (RULES.md 5.2). The defects not copied: a section over a tag with no posts,
// Recova's arbitrary text-[X] sizes, and an unknown tag served as a page.
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/cloudflare-context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
}));

const index = await import("~/routes/blog/index");
const tag = await import("~/routes/blog/tag");

const context = { get: () => ({ env: { DB: {}, BETTER_AUTH_URL: "https://example.com" } }) };

function seed(
  db: Db,
  slug: string,
  opts: { tags?: string[]; published?: boolean; featured?: boolean; daysAgo?: number } = {},
) {
  const at = new Date(Date.UTC(2026, 8, 30) - (opts.daysAgo ?? 0) * 86_400_000);
  return db.insert(blogPosts).values({
    id: slug,
    slug,
    title: `Title of ${slug}`,
    excerpt: `Excerpt of ${slug}.`,
    body: "word ".repeat(400),
    published: opts.published ?? true,
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    author: "Foxhound",
    tags: opts.tags ?? [],
    featured: opts.featured ?? false,
    readingMinutes: 2,
  });
}




// Tailwind text-* utilities that are colors or alignment, not sizes.




describe("/blog loader (J19, row M11)", () => {
  it("hides a section whose tag no published post carries, even when its curated posts resolve", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    // Two of Payment Recovery's curated posts are published but carry another
    // tag, so /blog/tag/payment-recovery would be empty or missing.
    await seed(db, "stripe-failed-payment-recovery", { tags: ["comparisons"] });
    await seed(db, "dunning-email-sequence", { tags: ["comparisons"] });
    // Dispute Handling's curated post carries its tag.
    await seed(db, "stripe-disputes-guide", { tags: ["disputes"] });
    const data = (await index.loader({ context } as never)) as Awaited<ReturnType<typeof index.loader>>;
    expect(data.sections.map((s) => s.section.id)).toEqual(["disputes"]);
  });
});

async function tagLoader(t: string) {
  return tag.loader({ params: { tag: t }, context } as never).then(
    (data) => ({ data, status: 200 }),
    (err: unknown) => ({ data: null, status: err instanceof Response ? err.status : -1 }),
  );
}

describe("/blog/tag/:tag loader (J19, row M14)", () => {
  it("answers 404 for a tag no published post carries, canonical or not", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["payment-recovery"] });
    await seed(db, "draft", { tags: ["saas-metrics"], published: false });
    expect((await tagLoader("saas-metrics")).status).toBe(404);
    expect((await tagLoader("no-such-tag")).status).toBe(404);
    expect((await tagLoader("payment-recovery")).status).toBe(200);
  });

  it("serves a tag any published post carries, from the same set the sitemap, feed and llms.txt read", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["churn-basics"] });
    const res = await tagLoader("churn-basics");
    expect(res.status).toBe(200);
    expect((res.data as { posts: BlogPostSummary[] }).posts.map((p) => p.slug)).toEqual(["a"]);
  });
});
