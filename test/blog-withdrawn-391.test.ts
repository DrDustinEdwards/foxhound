import { describe, expect, it, vi } from "vitest";

import { BLOG_SLUG_REDIRECTS } from "~/lib/blog/slug-redirects";
import {
  isWithdrawnBlogSlug,
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
    // The reader, mutated: an empty list would make this loop assert nothing
    // (379 binding 3).
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

  it("it is NOT a redirect, which is the ruled distinction", async () => {
    for (const slug of WITHDRAWN_BLOG_SLUGS) {
      const res = (await thrownFrom(slug)) as Response;
      expect(res.status).not.toBe(301);
      expect(res.status).not.toBe(302);
      expect(res.headers.get("Location"), `${slug} redirects somewhere`).toBeNull();
    }
  });

  it("and the message says why, rather than leaving a bare status", async () => {
    // A 410 with an empty body is a status code arguing with a human. The
    // sentence is the half a reader gets.
    expect(WITHDRAWN_BLOG_MESSAGE.length).toBeGreaterThan(60);
    expect(WITHDRAWN_BLOG_MESSAGE).toContain("withdrawn");
    expect(WITHDRAWN_BLOG_MESSAGE).toContain("verify");
  });
});

describe("PLANT 2: the withdrawal does not catch anything else", () => {
  it("a live post is not withdrawn", () => {
    expect(isWithdrawnBlogSlug("how-to-reduce-saas-churn")).toBe(false);
    expect(isWithdrawnBlogSlug("stripe-decline-codes")).toBe(false);
    expect(isWithdrawnBlogSlug("")).toBe(false);
  });

  it("an ordinary unknown slug still 404s, not 410", async () => {
    // The discriminator. If everything 410'd, a typo would claim the page once
    // existed and was deliberately removed, which is a different and false
    // statement.
    const res = (await thrownFrom("a-post-that-never-existed")) as Response;
    expect(res.status).toBe(404);
  });

  it("the withdrawn list and the redirect map do not overlap", () => {
    // A slug cannot both move and be gone. Overlap would make the answer depend
    // on which check runs first.
    for (const slug of WITHDRAWN_BLOG_SLUGS) {
      expect(Object.keys(BLOG_SLUG_REDIRECTS)).not.toContain(slug);
      expect(Object.values(BLOG_SLUG_REDIRECTS)).not.toContain(slug);
    }
  });

  it("the renamed slugs still redirect, so 391 did not disturb 376 item 21", async () => {
    const res = (await thrownFrom("recova-vs-churnkey")) as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/blog/foxhound-vs-churnkey");
  });
});
