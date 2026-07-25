import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { findBrandVoiceViolations, passesQualityGate } from "~/lib/recovery/email-generation";
import { buildTemplateEmail, type TemplateEmailInput } from "~/lib/recovery/email-template";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";

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

  it("never emits an em or en dash", () => {
    for (const category of ALL_CATEGORIES) {
      const copy = forCategory(category);
      expect(`${copy.subject}${copy.bodyHtml}`, category).not.toMatch(/[—–]/);
    }
  });

  // The generator is merely instructed not to leak the schedule. A fixed template
  // has no reason to reference time at all, so it references none.
  it("makes no timing reference in any form", () => {
    for (const category of ALL_CATEGORIES) {
      const text = `${forCategory(category).subject}${forCategory(category).bodyHtml}`;
      expect(text, category).not.toMatch(/\bday\s?\d+\b/i);
      expect(text, category).not.toMatch(/\b\d+\s+(?:hours?|days?)\b/i);
      expect(text, category).not.toMatch(/\b(?:yesterday|today|tomorrow)\b/i);
    }
  });

  it("never names Foxhound: the copy is the merchant's voice", () => {
    for (const category of ALL_CATEGORIES) {
      const copy = forCategory(category);
      // The update URL is a foxhoundapp.com link by construction, so strip hrefs
      // before asserting on the prose.
      const prose = copy.bodyHtml.replace(/href="[^"]*"/g, "");
      expect(`${copy.subject}${prose}`, category).not.toMatch(/foxhound/i);
    }
  });

  it("survives the preview sanitizer unchanged", () => {
    for (const category of ALL_CATEGORIES) {
      const copy = forCategory(category);
      expect(sanitizeEmailPreviewHtml(copy.bodyHtml), category).toBe(copy.bodyHtml);
    }
  });
});

describe("the template says the right thing per category", () => {
  it("always carries the update link as the call to action", () => {
    for (const category of ALL_CATEGORIES) {
      expect(forCategory(category).bodyHtml, category).toContain(base.updateUrl);
    }
  });

  it("always states the amount and signs as the merchant", () => {
    for (const category of ALL_CATEGORIES) {
      const body = forCategory(category).bodyHtml;
      expect(body, category).toContain("$49.00");
      expect(body, category).toContain("Teamflow");
    }
  });

  // The revoked category is a hard stop, not a dunning message: the customer told
  // their bank to stop paying. Asking them to pay would be both wrong and,
  // depending on jurisdiction, a compliance problem.
  it("does not dun a revoked authorization", () => {
    const body = forCategory("revoked").bodyHtml.toLowerCase();
    expect(body).toContain("will not attempt any further charges");
    expect(body).not.toMatch(/\bplease pay\b/);
    expect(body).not.toMatch(/\byou owe\b/);
    expect(body).not.toMatch(/\bpast due\b/);
  });

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

  it("gives an unmapped category the soft-decline default rather than throwing", () => {
    const copy = forCategory("some_future_category");
    expect(copy.bodyHtml).toContain("temporary hold");
    expect(copy.subject).toContain("Teamflow");
  });
});

describe("the template is pure", () => {
  it("is deterministic across calls", () => {
    expect(buildTemplateEmail(base)).toEqual(buildTemplateEmail(base));
  });

  it("reflects the merchant name it is given", () => {
    const copy = buildTemplateEmail({ ...base, merchantName: "Bolt Supply" });
    expect(copy.bodyHtml).toContain("Bolt Supply");
    expect(copy.bodyHtml).not.toContain("Teamflow");
  });
});
