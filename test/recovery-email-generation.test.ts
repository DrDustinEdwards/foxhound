import { describe, expect, it } from "vitest";

import {
  applyCustomBody,
  findBrandVoiceViolations,
  passesQualityGate,
  resolveBrandVoice,
  resolveContentPlan,
  sanitizeCopy,
  stripEmDashes,
} from "~/lib/recovery/email-generation";

describe("sanitizers (hard brand rules)", () => {
  it("strips em and en dashes, replacing with a comma", () => {
    expect(stripEmDashes("Your payment—the one from Tuesday—failed")).toBe(
      "Your payment, the one from Tuesday, failed",
    );
    expect(stripEmDashes("range 3–5")).toBe("range 3, 5");
  });

  it("removes AI-tell filler and collapses the whitespace left behind", () => {
    const out = sanitizeCopy("I hope this email finds you well. Your card was declined.");
    expect(out).toBe("Your card was declined.");
    expect(out).not.toMatch(/finds you well/i);
  });

  it("sanitized copy has no dashes remaining", () => {
    expect(sanitizeCopy("update now — it only takes a minute")).not.toMatch(/[—–]/);
  });
});

describe("brand-voice quality gate", () => {
  it("passes clean merchant-voice copy", () => {
    const copy = {
      subject: "Your Acme payment needs a quick fix",
      bodyHtml: "<p>Hi, your card did not go through. Update it here.</p>",
    };
    expect(findBrandVoiceViolations(copy)).toEqual([]);
    expect(passesQualityGate(copy)).toBe(true);
  });

  it("flags an em dash", () => {
    const copy = { subject: "Payment failed — act now", bodyHtml: "<p>ok</p>" };
    expect(findBrandVoiceViolations(copy)).toContain("em_dash");
    expect(passesQualityGate(copy)).toBe(false);
  });

  it("flags an internal-schedule timing leak (detector, not stripped)", () => {
    const copy = {
      subject: "Reminder",
      bodyHtml: "<p>Your payment failed 3 days ago, please update.</p>",
    };
    expect(findBrandVoiceViolations(copy)).toContain("timing_leak");
  });

  it("flags 'day N' schedule leaks and empty copy", () => {
    expect(
      findBrandVoiceViolations({ subject: "Day 3 notice", bodyHtml: "<p>x</p>" }),
    ).toContain("timing_leak");
    expect(
      findBrandVoiceViolations({ subject: "", bodyHtml: "<p>x</p>" }),
    ).toContain("empty");
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

  it("generates when the subject is missing, carrying custom_body forward", () => {
    const plan = resolveContentPlan({
      customBody: "<p>merchant body</p>",
      cachedSubject: null,
      cachedBodyHtml: null,
    });
    expect(plan.source).toBe("generate");
    if (plan.source === "generate") {
      expect(plan.customBody).toBe("<p>merchant body</p>");
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
  it("custom body overrides a generated body but keeps the generated subject", () => {
    const merged = applyCustomBody(
      { subject: "Generated subject", bodyHtml: "<p>generated</p>" },
      "<p>custom</p>",
    );
    expect(merged).toEqual({ subject: "Generated subject", bodyHtml: "<p>custom</p>" });
  });

  it("keeps the generated body when there is no custom body", () => {
    const merged = applyCustomBody(
      { subject: "S", bodyHtml: "<p>generated</p>" },
      null,
    );
    expect(merged.bodyHtml).toBe("<p>generated</p>");
  });

  it("resolves a default voice when the merchant has none, else the merchant's", () => {
    expect(resolveBrandVoice({ merchantName: "Acme" })).toMatch(/warm/);
    expect(
      resolveBrandVoice({ merchantName: "Acme", voiceDescription: "  " }),
    ).toMatch(/warm/);
    expect(
      resolveBrandVoice({ merchantName: "Acme", voiceDescription: "cheeky and brief" }),
    ).toBe("cheeky and brief");
  });
});
