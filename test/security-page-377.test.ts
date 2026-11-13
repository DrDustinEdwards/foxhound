import { describe, expect, it } from "vitest";

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
