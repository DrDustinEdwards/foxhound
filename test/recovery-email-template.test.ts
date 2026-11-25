import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { findBrandVoiceViolations, passesQualityGate } from "~/lib/recovery/email-generation";
import { buildTemplateEmail, type TemplateEmailInput } from "~/lib/recovery/email-template";

const base: TemplateEmailInput = {
  merchantName: "Teamflow",
  declineCategory: "soft",
  amountFormatted: "$49.00",
  updateUrl: "https://foxhoundapp.com/e/c/tok123",
};

const forCategory = (declineCategory: string) => buildTemplateEmail({ ...base, declineCategory });

// Every category the engine can classify, plus an unmapped one.
const ALL_CATEGORIES = [...DECLINE_CATEGORIES, "some_future_category"];

describe("the template is always gate-clean", () => {
  // The template is what the gate falls back to, so it must always pass.
  it("passes the quality gate for every decline category", () => {
    const failures: string[] = [];
    for (const category of ALL_CATEGORIES) {
      const copy = forCategory(category);
      if (!passesQualityGate(copy)) {
        failures.push(`${category}: ${findBrandVoiceViolations(copy).join(",")}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("the merchant's name is words, never markup", () => {
  it("escapes the name in the body for every category", () => {
    for (const declineCategory of ALL_CATEGORIES) {
      const { bodyHtml } = buildTemplateEmail({
        ...base,
        declineCategory,
        merchantName: "Acme <img src=x>",
      });
      expect(bodyHtml).not.toContain("<img");
      expect(bodyHtml).toContain("Acme &lt;img src=x&gt;");
    }
  });
});
