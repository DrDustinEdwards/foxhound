import { describe, expect, it } from "vitest";

import { RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";

import { LEGACY_MARKETING_ROUTES } from "./fixtures/legacy-marketing-routes";

// The coverage assertions below are checked against
// test/fixtures/legacy-marketing-routes.ts, a snapshot of the legacy repo's
// actual `app/` tree (see that file's header for exactly what was walked
// and why), NOT a list re-typed here to match RECOVA_REDIRECT_MAP. A route
// present in the fixture but missing from the map, or a map entry the
// fixture doesn't recognize, fails the test either way, so this can
// actually catch a real gap (see git history: it once did, for
// /blog/sitemap.xml).

describe("RECOVA_REDIRECT_MAP", () => {
  it("has a mapping entry for every legacy marketing route in the fixture", () => {
    const mappedFroms = new Set(RECOVA_REDIRECT_MAP.map((e) => e.from));
    for (const route of LEGACY_MARKETING_ROUTES) {
      expect(mappedFroms.has(route.url), `missing redirect mapping for ${route.url} (${route.sourceFile})`).toBe(
        true,
      );
    }
  });

  it("has no entries beyond the fixture's routes (map and fixture stay in sync)", () => {
    const fixtureUrls = new Set(LEGACY_MARKETING_ROUTES.map((r) => r.url));
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(fixtureUrls.has(entry.from), `${entry.from} is mapped but not in the legacy-routes fixture`).toBe(true);
    }
  });

  it("has no duplicate source paths", () => {
    const froms = RECOVA_REDIRECT_MAP.map((e) => e.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("the fixture itself has no duplicate URLs", () => {
    const urls = LEGACY_MARKETING_ROUTES.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("every target path is a real Foxhound path starting with /", () => {
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(entry.to.startsWith("/")).toBe(true);
    }
  });

  it("maps /product/* to /products/* per ROUTES.md's collapsed pattern", () => {
    const productEntries = RECOVA_REDIRECT_MAP.filter((e) => e.from.startsWith("/product/"));
    expect(productEntries.length).toBeGreaterThan(0);
    for (const entry of productEntries) {
      expect(entry.to).toBe(entry.from.replace("/product/", "/products/"));
    }
  });

  it("maps /console to /dashboard", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/console")?.to).toBe("/dashboard");
  });

  it("maps /features to /products", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/features")?.to).toBe("/products");
  });

  it("maps blog slugs and tag slugs verbatim", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/:slug")?.to).toBe("/blog/:slug");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/tag/:tag")?.to).toBe("/blog/tag/:tag");
  });

  it("self-maps the top-level SEO/utility file routes", () => {
    for (const path of ["/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt", "/feed.rss"]) {
      expect(RECOVA_REDIRECT_MAP.find((e) => e.from === path)?.to).toBe(path);
    }
  });

  it("consolidates the per-section blog RSS/sitemap routes onto Foxhound's single equivalents", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/rss.xml")?.to).toBe("/feed.rss");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/sitemap.xml")?.to).toBe("/sitemap.xml");
  });
});
