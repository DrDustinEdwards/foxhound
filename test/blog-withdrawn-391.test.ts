import { describe, expect, it, vi } from "vitest";

import {
  WITHDRAWN_BLOG_MESSAGE,
  WITHDRAWN_BLOG_SLUGS,
} from "~/lib/blog/withdrawn";

import { createInMemoryDb } from "./helpers/inmemory-db";

// 391: TWO POSTS ARE WITHDRAWN, AND THE OLD URL SAYS SO.
//
// Both were built almost entirely on third-party benchmarks whose sources could
// not be verified against any fixed document, live or archived. Repairing them
// would have left the article with its evidence gone, so Dustin ruled they come
// down: the row is unpublished, the body stays in the store, and the URL answers
// 410.
//
// 410 RATHER THAN 301, and the plant pins the distinction because it is the
// decision: a 301 to the blog index would assert a replacement that does not
// exist, which a crawler treats as a soft 404 anyway. 410 says the page is
// deliberately gone.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/cloudflare-context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
}));

const { loader } = await import("~/routes/blog/post");

function loaderArgs(slug: string) {
  harness.db = createInMemoryDb().db;
  return {
    params: { slug },
    request: new Request(`https://foxhoundapp.com/blog/${slug}`),
    context: { get: () => ({ env: { DB: {} } }) },
  } as unknown as Parameters<typeof loader>[0];
}

async function thrownFrom(slug: string): Promise<unknown> {
  return loader(loaderArgs(slug)).then(
    () => null,
    (err: unknown) => err,
  );
}

describe("PLANT 1: a withdrawn slug answers 410", () => {
  it("BOTH WITHDRAWN POSTS RETURN 410, driven through the real loader", async () => {
    // The reader, mutated: an empty list would make this loop assert nothing.
    expect(WITHDRAWN_BLOG_SLUGS).toHaveLength(2);
    expect(WITHDRAWN_BLOG_SLUGS).toContain("net-revenue-retention-guide");
    expect(WITHDRAWN_BLOG_SLUGS).toContain("subscription-intelligence-churn-prediction");

    for (const slug of WITHDRAWN_BLOG_SLUGS) {
      const thrown = await thrownFrom(slug);
      expect(thrown, `${slug} did not respond`).toBeInstanceOf(Response);
      const res = thrown as Response;
      expect(res.status, `${slug} is not 410`).toBe(410);
      expect(await res.text()).toBe(WITHDRAWN_BLOG_MESSAGE);
    }
  });
});

describe("PLANT 2: the withdrawal does not catch anything else", () => {

  it("an ordinary unknown slug still 404s, not 410", async () => {
    // The discriminator. If everything 410'd, a typo would claim the page once
    // existed and was deliberately removed, which is a different and false
    // statement.
    const res = (await thrownFrom("a-post-that-never-existed")) as Response;
    expect(res.status).toBe(404);
  });
});

describe("a post's JSON-LD cannot close its own script element", () => {
  it("a title carrying </script> renders escaped inside the ld+json block", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createRoutesStub } = await import("react-router");
    const { blogPosts } = await import("~/db/schema");
    const route = await import("~/routes/blog/post");

    const args = loaderArgs("escape-check");
    const at = new Date("2026-09-01T00:00:00.000Z");
    await (harness.db as ReturnType<typeof createInMemoryDb>["db"]).insert(blogPosts).values({
      id: "escape-check",
      slug: "escape-check",
      title: "Dunning </script><script>alert(1)</script>",
      excerpt: "Excerpt.",
      body: "word ".repeat(50),
      published: true,
      publishedAt: at,
      createdAt: at,
      updatedAt: at,
      author: "Foxhound",
      tags: [],
      featured: false,
      readingMinutes: 1,
    });
    const data = await loader(args);
    const Page = route.default as unknown as (props: { loaderData: typeof data }) => ReturnType<typeof createElement>;
    const Stub = createRoutesStub([
      { path: "/blog/:slug", Component: () => createElement(Page, { loaderData: data }) },
    ]);
    const html = renderToStaticMarkup(createElement(Stub, { initialEntries: ["/blog/escape-check"] }));
    expect(html).toContain("application/ld+json");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Dunning \\u003c/script\\u003e");
  });
});
