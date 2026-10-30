import { describe, expect, it } from "vitest";

import {
  resolveBrandVoice,
  resolveContentPlan,
  stripEmDashes,
} from "~/lib/recovery/email-generation";

describe("sanitizers (hard brand rules)", () => {
  it("strips em and en dashes, replacing with a comma", () => {
    expect(stripEmDashes("Your payment—the one from Tuesday—failed")).toBe(
      "Your payment, the one from Tuesday, failed",
    );
    expect(stripEmDashes("range 3–5")).toBe("range 3, 5");
  });

});

describe("cache-order resolution (custom_body -> cached -> generate)", () => {
  it("uses cached subject + cached body when both present", () => {
    const plan = resolveContentPlan({
      customBody: null,
      cachedSubject: "Cached subject",
      cachedBodyHtml: "<p>cached</p>",
    });
    expect(plan.source).toBe("cache");
    if (plan.source === "cache") {
      expect(plan.copy.bodyHtml).toBe("<p>cached</p>");
      expect(plan.usedCustomBody).toBe(false);
    }
  });

  it("custom_body wins over cached AI body", () => {
    const plan = resolveContentPlan({
      customBody: "<p>merchant wrote this</p>",
      cachedSubject: "Cached subject",
      cachedBodyHtml: "<p>ai body</p>",
    });
    expect(plan.source).toBe("cache");
    if (plan.source === "cache") {
      expect(plan.copy.bodyHtml).toBe("<p>merchant wrote this</p>");
      expect(plan.usedCustomBody).toBe(true);
    }
  });

  it("generates when both subject and body are missing", () => {
    const plan = resolveContentPlan({
      customBody: null,
      cachedSubject: null,
      cachedBodyHtml: null,
    });
    expect(plan.source).toBe("generate");
  });
});

describe("applyCustomBody + brand voice", () => {

  it("resolves a default voice when the merchant has none, else the merchant's", () => {
    // The third rung is legacy's BRAND_VOICE_DEFAULT, byte for byte.
    expect(resolveBrandVoice({ merchantName: "Acme" }, "soft")).toBe(
      "Friendly and direct. Write like a real person, not a company.",
    );
    expect(
      resolveBrandVoice({ merchantName: "Acme", voiceDescription: "  " }, "soft"),
    ).toBe("Friendly and direct. Write like a real person, not a company.");
    expect(
      resolveBrandVoice({ merchantName: "Acme", voiceDescription: "cheeky and brief" }, "soft"),
    ).toBe("cheeky and brief");
  });
});
