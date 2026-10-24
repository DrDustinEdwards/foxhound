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

// Every category the engine can classify, plus an unmapped one to prove the
// default branch is reachable and safe. Sweeping rather than sampling: the whole
// point of this module is that it is ALWAYS gate-clean, which one input cannot show.
const ALL_CATEGORIES = [...DECLINE_CATEGORIES, "some_future_category"];

describe("the template is always gate-clean", () => {
  // This is the load-bearing property. The template is what the gate falls back
  // TO, so if it could fail the gate there would be nowhere left to go.
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

describe("the template says the right thing per category", () => {

  it("tells an expired card that retrying will not help", () => {
    expect(forCategory("expired").bodyHtml).toContain("Retrying will not help");
    expect(forCategory("expired").subject).toBe("Your card has expired");
  });

  // Repeated attempts against a fraud-flagged card make the bank more likely to
  // keep blocking, which is why the engine does not retry it.
  it("explains why a fraud-flagged card is not retried", () => {
    expect(forCategory("fraud").bodyHtml).toContain("more likely to keep blocking");
  });

  it("does not blame the customer for a network failure", () => {
    expect(forCategory("network").bodyHtml).toContain("not because of anything on your side");
  });

  it("admits it does not know the cause of an unclassified decline", () => {
    expect(forCategory("unknown").bodyHtml).toContain("did not tell us why");
  });
});
