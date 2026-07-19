import { describe, expect, it } from "vitest";

import { estimateReadingTime, formatTagChip, generateSlug } from "~/lib/blog/format";

describe("generateSlug", () => {
  it("lowercases, strips punctuation, and hyphenates", () => {
    expect(generateSlug("Stripe Decline Codes: What They Mean")).toBe(
      "stripe-decline-codes-what-they-mean",
    );
  });

  it("collapses repeated whitespace and hyphens", () => {
    expect(generateSlug("Foo   Bar--Baz")).toBe("foo-bar-baz");
  });
});

describe("estimateReadingTime", () => {
  it("is at least 1 minute for very short content", () => {
    expect(estimateReadingTime("a few words")).toBe(1);
  });

  it("scales with word count at ~200 words/minute", () => {
    const words = new Array(400).fill("word").join(" ");
    expect(estimateReadingTime(words)).toBe(2);
  });
});

describe("formatTagChip", () => {
  it("title-cases a kebab-case tag", () => {
    expect(formatTagChip("payment-recovery")).toBe("Payment Recovery");
  });
});
