
import { describe, expect, it } from "vitest";

import { classifyPath } from "~/lib/http/cache-policy";
import { STATIC_PAGES } from "~/routes/files/sitemap";




describe("PLANT 4: the page is reachable", () => {
  it("it is in the sitemap", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/security");
    // Beside the other two legal pages, so a future tidy cannot drop one.
    expect(paths).toContain("/privacy");
    expect(paths).toContain("/terms");
  });
});

describe("PLANT 5: every page in the sitemap is publicly cacheable", () => {
  // THE GUARD THAT WOULD HAVE CAUGHT THIS ONE. /security shipped in the sitemap,
  // the footer and the route tree, and was served `private, no-store`, because
  // cache-policy classifies everything unlisted as private and nobody listed it.
  // Measured live before this test existed.
  //
  // DERIVED FROM STATIC_PAGES rather than listing the pages again: a public page
  // that a crawler is invited to index must not be uncacheable, and the next
  // page added is covered on the day it enters the sitemap.
  it("no STATIC_PAGES entry classifies as private", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      expect(classifyPath(path), `${path} is in the sitemap but served private`).not.toBe("private");
    }
  });

  it("and /security specifically is marketing, like /privacy and /terms", () => {
    expect(classifyPath("/security")).toBe("marketing");
    expect(classifyPath("/privacy")).toBe("marketing");
    expect(classifyPath("/terms")).toBe("marketing");
  });
});
