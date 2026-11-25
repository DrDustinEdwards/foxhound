import { describe, expect, it } from "vitest";

import { softwareApplicationJsonLd } from "~/lib/seo/jsonld";

// No single price is true of the application, so JSON-LD must publish none.

const URL_BASE = "https://foxhoundapp.com";

describe("SoftwareApplication JSON-LD", () => {
  const jsonld = softwareApplicationJsonLd(URL_BASE) as Record<string, unknown>;

  it("publishes no price", () => {
    const offers = jsonld.offers as { price?: string } | undefined;
    expect(offers?.price).toBeUndefined();
  });
});
