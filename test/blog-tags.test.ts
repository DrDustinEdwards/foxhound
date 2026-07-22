import { describe, expect, it } from "vitest";

import { CANONICAL_TAGS, filterPostsByTag, labelForTag } from "~/lib/blog/tags";

describe("CANONICAL_TAGS", () => {
  it("is the 8 tags from Blog Roadmap Part 5, in order", () => {
    expect(CANONICAL_TAGS).toEqual([
      "payment-recovery",
      "disputes",
      "subscription-intelligence",
      "decline-codes",
      "stripe-for-saas",
      "saas-pricing",
      "saas-metrics",
      "comparisons",
    ]);
  });
});

describe("labelForTag", () => {
  it("returns the curated label for every canonical tag", () => {
    expect(labelForTag("payment-recovery")).toBe("Payment Recovery");
    expect(labelForTag("disputes")).toBe("Dispute Handling");
    expect(labelForTag("subscription-intelligence")).toBe("Subscription Intelligence");
    expect(labelForTag("decline-codes")).toBe("Decline Codes");
    expect(labelForTag("stripe-for-saas")).toBe("Stripe for SaaS");
    expect(labelForTag("saas-pricing")).toBe("SaaS Pricing");
    expect(labelForTag("saas-metrics")).toBe("SaaS Metrics");
    expect(labelForTag("comparisons")).toBe("Comparisons");
  });

  it("humanizes an unrecognized tag instead of throwing or 404ing", () => {
    expect(labelForTag("some-future-tag")).toBe("some future tag");
  });
});

describe("filterPostsByTag", () => {
  // Two posts with disjoint tag sets (foxhound-audit-content.md MEDIUM-1:
  // the /blog/tag/payment-recovery archive was suspected of returning every
  // post unfiltered; live D1 data showed the filter was already correct,
  // this test locks that in with a fast, DB-free case).
  const postA = { slug: "a", tags: ["payment-recovery"] };
  const postB = { slug: "b", tags: ["disputes"] };
  const postC = { slug: "c", tags: ["payment-recovery", "comparisons"] };

  it("returns only posts whose tags include the requested tag", () => {
    expect(filterPostsByTag([postA, postB, postC], "payment-recovery")).toEqual([postA, postC]);
    expect(filterPostsByTag([postA, postB, postC], "disputes")).toEqual([postB]);
  });

  it("returns an empty array for a tag no post carries", () => {
    expect(filterPostsByTag([postA, postB], "saas-metrics")).toEqual([]);
  });

  it("a multi-tag post appears on every one of its own tag archives", () => {
    expect(filterPostsByTag([postC], "payment-recovery")).toEqual([postC]);
    expect(filterPostsByTag([postC], "comparisons")).toEqual([postC]);
  });
});
