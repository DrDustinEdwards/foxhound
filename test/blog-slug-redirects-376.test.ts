import { describe, expect, it, vi } from "vitest";

import { BLOG_SLUG_REDIRECTS, redirectedBlogSlug } from "~/lib/blog/slug-redirects";

import { createInMemoryDb } from "./helpers/inmemory-db";

// 376 ITEM 21: THE FOUR COMPARISON SLUGS ARE RENAMED, AND THE OLD PATHS 301.
//
// Four posts shipped under `recova-vs-*` and kept those URLs through the rename,
// verified against the live content store at 2569400: their TITLES already said
// Foxhound, and only the paths still carried the previous product's name, which
// put it in the canonical tag, the sitemap and every inbound link. Branding
// divergence needs no ratification, so the slugs move and the old paths keep
// working.
//
// EACH REDIRECT IS DRIVEN WITH A REAL REQUEST through the route's own loader,
// which is what the brief asked for and what a table-only assertion cannot do: a
// redirect map that nothing consumes is exactly the defect 376 item 21 recorded
// about RECOVA_REDIRECT_MAP, and a test that reads the table would pass against
// a route that never calls it.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/cloudflare-context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
}));

const { loader } = await import("~/routes/blog/post");

/** The loader's context shape: a `get` returning the cloudflare env bag. */
function loaderArgs(slug: string) {
  harness.db = createInMemoryDb().db;
  return {
    params: { slug },
    request: new Request(`https://foxhoundapp.com/blog/${slug}`),
    context: { get: () => ({ env: { DB: {} } }) },
  } as unknown as Parameters<typeof loader>[0];
}

describe("PLANT 1: every old slug 301s to its new one, driven through the loader", () => {
  it("ALL FOUR REDIRECT, with the status and the Location asserted", async () => {
    const entries = Object.entries(BLOG_SLUG_REDIRECTS);
    // The reader, mutated: an empty map would make this loop assert nothing
    // (379 binding 3).
    expect(entries).toHaveLength(4);

    for (const [oldSlug, newSlug] of entries) {
      // The loader THROWS a Response for a redirect, which is React Router's
      // contract, so the throw is the result rather than a failure.
      const thrown = await loader(loaderArgs(oldSlug)).then(
        () => null,
        (err: unknown) => err,
      );

      expect(thrown, `${oldSlug} did not redirect`).toBeInstanceOf(Response);
      const res = thrown as Response;
      expect(res.status, `${oldSlug} is not a permanent redirect`).toBe(301);
      expect(res.headers.get("Location"), `${oldSlug} points at the wrong place`).toBe(
        `/blog/${newSlug}`,
      );
    }
  });

  it("a slug that was never renamed is NOT redirected", () => {
    // The discriminator. A redirect that fires on everything would send every
    // post to a 404 rather than only the four.
    expect(redirectedBlogSlug("how-to-reduce-saas-churn")).toBeNull();
    expect(redirectedBlogSlug("foxhound-vs-churnkey")).toBeNull();
    expect(redirectedBlogSlug("")).toBeNull();
  });
});
