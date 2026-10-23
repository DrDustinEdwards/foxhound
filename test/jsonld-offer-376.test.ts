import { describe, expect, it } from "vitest";

import {
  INTELLIGENCE_PRICE_CENTS,
} from "~/lib/constants";
import { softwareApplicationJsonLd } from "~/lib/seo/jsonld";

// 376 ITEM 22, CITED AND NOT OPENED, VERIFIED TRUE AT 2569400: the
// SoftwareApplication JSON-LD published `offers.price: "0"`.
//
// The description beside it was accurate ("Free audit. Recovery at 20% of
// Foxhound-attributed recoveries") and the PRICE was not. Zero is the audit's
// price. A crawler reading this object reads one price for the whole
// application, so the markup told search engines the product is free while
// Recovery bills a percentage of created value and Intelligence bills monthly.
//
// A machine-readable false price is worse than a prose one: it is quoted without
// the sentence that would have qualified it.

const URL_BASE = "https://foxhoundapp.com";

describe("PLANT 1: no price is published for a product that has three", () => {
  const jsonld = softwareApplicationJsonLd(URL_BASE) as Record<string, unknown>;

  it("ANY price that ever returns must match a real pricing constant", () => {
    // The forward guard. A future Offer is welcome once a fixed-price plan has a
    // checkout, but it may not carry an invented number, so the permitted set is
    // derived from PRICING's own constants rather than listed.
    const permitted = new Set([
      String(INTELLIGENCE_PRICE_CENTS / 100),
      (INTELLIGENCE_PRICE_CENTS / 100).toFixed(2),
    ]);
    // The reader, mutated: an empty permitted set would make the check below
    // vacuous, and would also silently permit nothing at all.
    expect(permitted.size).toBeGreaterThan(0);
    expect(permitted.has("199")).toBe(true);

    const offers = jsonld.offers as { price?: string } | undefined;
    if (offers?.price !== undefined) {
      expect(permitted.has(offers.price), `price ${offers.price} is not a pricing constant`).toBe(
        true,
      );
    }
  });
});
