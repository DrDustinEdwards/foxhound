import { describe, expect, it } from "vitest";

import { softwareApplicationJsonLd } from "~/lib/seo/jsonld";

// 376 ITEM 22, CITED AND NOT OPENED, VERIFIED TRUE AT 2569400: the
// SoftwareApplication JSON-LD published `offers.price: "0"`.
//
// The description beside it was accurate ("Free audit. Recovery at 20% of
// Foxhound-attributed recoveries") and the PRICE was not. Zero is the audit's
// price. A crawler reading this object reads one price for the whole
// application, so the markup told search engines the product is free while
// Recovery bills a percentage of created value.
//
// A machine-readable false price is worse than a prose one: it is quoted without
// the sentence that would have qualified it.

const URL_BASE = "https://foxhoundapp.com";

describe("PLANT 1: no price is published for a product that has three", () => {
  const jsonld = softwareApplicationJsonLd(URL_BASE) as Record<string, unknown>;

  it("publishes no price: every paid product is a percentage", () => {
    // Intelligence is free (Dustin, 2026-10-29) and Recovery and Disputes bill a
    // share of created value, so no single number is true of the application.
    const offers = jsonld.offers as { price?: string } | undefined;
    expect(offers?.price).toBeUndefined();
  });
});
