import { describe, expect, it } from "vitest";

import { CANONICAL_TAGS, labelForTag } from "~/lib/blog/tags";

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
