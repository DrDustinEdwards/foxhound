import { describe, expect, it } from "vitest";

import { softwareApplicationJsonLd } from "~/lib/seo/jsonld";

// A machine-readable false price is quoted without the sentence that would
// qualify it: Intelligence is free, Recovery and Disputes bill a share of created
// value, so no single price is true of the application.

const URL_BASE = "https://foxhoundapp.com";

describe("SoftwareApplication JSON-LD", () => {
  const jsonld = softwareApplicationJsonLd(URL_BASE) as Record<string, unknown>;

  it("publishes no price", () => {
    const offers = jsonld.offers as { price?: string } | undefined;
    expect(offers?.price).toBeUndefined();
  });
});
