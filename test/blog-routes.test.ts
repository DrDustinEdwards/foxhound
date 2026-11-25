import { describe, expect, it, vi } from "vitest";

import { blogPosts, blogSlugRedirects } from "~/db";
import type { Db } from "~/db";
import type { BlogPostSummary } from "~/lib/blog/queries.server";
import { WITHDRAWN_BLOG_MESSAGE, WITHDRAWN_BLOG_SLUGS } from "~/lib/blog/withdrawn";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("@dustinedwards/site-runtime/context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
  previewContext: () => Symbol("preview") as unknown,
}));

const index = await import("~/routes/blog/index");
const tag = await import("~/routes/blog/tag");
const { loader } = await import("~/routes/blog/post");

const indexContext = { get: () => ({ env: { DB: {}, BETTER_AUTH_URL: "https://example.com" } }) };

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

describe("/blog loader", () => {
  it("hides a section whose tag no published post carries, even when its curated posts resolve", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "stripe-failed-payment-recovery", { tags: ["comparisons"] });
    await seed(db, "dunning-email-sequence", { tags: ["comparisons"] });
    await seed(db, "stripe-disputes-guide", { tags: ["disputes"] });
    const data = (await index.loader({ context: indexContext } as never)) as Awaited<
      ReturnType<typeof index.loader>
    >;
    expect(data.sections.map((s) => s.section.id)).toEqual(["disputes"]);
  });
});

async function tagLoader(t: string) {
  return tag.loader({ params: { tag: t }, context: indexContext } as never).then(
    (data) => ({ data, status: 200 }),
    (err: unknown) => ({ data: null, status: err instanceof Response ? err.status : -1 }),
  );
}

describe("/blog/tag/:tag loader", () => {
  it("answers 404 for a tag no published post carries, and serves one that does", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["payment-recovery"] });
    await seed(db, "draft", { tags: ["saas-metrics"], published: false });
    expect((await tagLoader("saas-metrics")).status).toBe(404);
    expect((await tagLoader("no-such-tag")).status).toBe(404);
    const res = await tagLoader("payment-recovery");
    expect(res.status).toBe(200);
    expect((res.data as { posts: BlogPostSummary[] }).posts.map((p) => p.slug)).toEqual(["a"]);
  });
});

function postArgs(slug: string) {
  harness.db = createInMemoryDb().db;
  return {
    params: { slug },
    request: new Request(`https://foxhoundapp.com/blog/${slug}`),
    // Only the Cloudflare context holds anything; the preview draft is null, as on a reader's request.
    context: {
      get: (key: symbol) => (String(key) === "Symbol(cloudflare)" ? { env: { DB: {} } } : null),
    },
  } as unknown as Parameters<typeof loader>[0];
}

async function thrownFrom(slug: string): Promise<unknown> {
  return loader(postArgs(slug)).then(
    () => null,
    (err: unknown) => err,
  );
}

// 410, not 301: a redirect to the blog index would assert a replacement that does not exist.
describe("/blog/:slug loader", () => {
  it("answers 410 for both withdrawn posts, and 404 (not 410) for an unknown slug", async () => {
    // An empty list would make the loop assert nothing.
    expect(WITHDRAWN_BLOG_SLUGS).toHaveLength(2);
    for (const slug of WITHDRAWN_BLOG_SLUGS) {
      const res = (await thrownFrom(slug)) as Response;
      expect(res, `${slug} did not respond`).toBeInstanceOf(Response);
      expect(res.status, `${slug} is not 410`).toBe(410);
      expect(await res.text()).toBe(WITHDRAWN_BLOG_MESSAGE);
    }
    expect(((await thrownFrom("a-post-that-never-existed")) as Response).status).toBe(404);
  });

  it("answers 301 to the new slug, query kept, for a renamed post's old address", async () => {
    const args = postArgs("why-cards-fail");
    await (harness.db as ReturnType<typeof createInMemoryDb>["db"])
      .insert(blogSlugRedirects)
      .values({ fromSlug: "why-cards-fail", toSlug: "why-cards-decline", createdAt: new Date() });
    args.request = new Request("https://foxhoundapp.com/blog/why-cards-fail?ref=a");
    const res = (await loader(args).catch((err: unknown) => err)) as Response;
    expect([res.status, res.headers.get("location")]).toEqual([
      301,
      "https://foxhoundapp.com/blog/why-cards-decline?ref=a",
    ]);
  });
});
