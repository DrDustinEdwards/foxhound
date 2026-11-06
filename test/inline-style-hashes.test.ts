import { scriptHash } from "@dustinedwards/site-runtime/csp";
import { describe, expect, it } from "vitest";

import { BLOG_COVER_FALLBACK_CSS, FEATURE_FILTER_CSS, INLINE_STYLE_HASHES } from "~/lib/http/inline-styles";

// What a header check cannot see: that the hashed styles are the ones rendered.

describe("inline <style> elements are trusted by hash, never by 'unsafe-inline'", () => {
  it("each hash is the SHA-256 of the exact CSS the page renders", async () => {
    const computed = await Promise.all([FEATURE_FILTER_CSS, BLOG_COVER_FALLBACK_CSS].map((css) => scriptHash(css)));
    expect([...INLINE_STYLE_HASHES].sort()).toEqual(computed.sort());
  });

  it("every <style> element in app/ renders one of the hashed constants", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync("git grep -n '<style' -- 'app/*.tsx' || true", { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    // Control: the two known elements must be found, or the search proves nothing.
    expect(hits.length).toBe(2);
    for (const hit of hits) expect(hit).toMatch(/<style>\{(FEATURE_FILTER_CSS|BLOG_COVER_FALLBACK_CSS)\}<\/style>/);
  });
});
