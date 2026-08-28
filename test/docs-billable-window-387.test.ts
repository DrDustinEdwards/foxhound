import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLICK_SUSPECT_MIN_SECONDS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  EMAIL_ENGAGEMENT_WINDOW_MS,
} from "~/lib/constants";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");

// 387 ITEM 2: THE DOCS NOW STATE THE TWO RULES 380 SHIPPED.
//
// 380 tightened billable attribution twice and neither change reached the
// customer-facing copy. `email_engaged` now requires a click that PRECEDES the
// recovery by no more than the engagement window, and a click that trips the
// scanner tests is marked suspect and never billed. A merchant reading "a
// dunning email was clicked" would have expected a fee on a recovery Foxhound
// deliberately does not charge for, which is the promise failing in the
// merchant's favour and still a promise failing.
//
// THE NUMBERS ARE DERIVED, NEVER TYPED. Both appear in copy as interpolations of
// the constants the engine bills on, so a change to the window cannot leave the
// documentation describing the old rule. That is the whole instruction of the
// item and the reason a plant reads the constant rather than the sentence.

function flatten(blocks: DocBlock[]): string {
  const inline = (node: DocInline): string =>
    typeof node === "string"
      ? node
      : "code" in node
        ? node.code
        : "strong" in node
          ? node.strong
          : "mono" in node
            ? node.mono
            : node.link;
  const rich = (r: string | DocInline[]) => (typeof r === "string" ? r : r.map(inline).join(""));
  return blocks
    .map((b) => {
      if (typeof b === "string") return b;
      switch (b.kind) {
        case "p":
          return rich(b.body);
        case "h3":
          return b.text;
        case "note":
        case "tip":
          return rich(b.body);
        case "steps":
        case "list":
          return b.items.map(rich).join(" ");
        case "table":
          return [...b.columns, ...b.rows.flat().map(rich)].join(" ");
        case "widget":
          return b.name;
      }
    })
    .join("\n");
}

function guideText(slug: string): string {
  const guide = DOC_GUIDES.find((g) => g.slug === slug);
  if (!guide) throw new Error(`no guide ${slug}`);
  return guide.sections.map((s) => flatten(s.body)).join("\n");
}

describe("PLANT 1: the window in the docs is the window the engine bills on", () => {
  const recovery = guideText("recovery");

  it("THE CONSTANT AND THE COPY AGREE, derived not transcribed", () => {
    // The reader, mutated: a zero or absent window would make the sentence
    // assertion below match nothing meaningful (379 binding 3).
    expect(EMAIL_ENGAGEMENT_WINDOW_DAYS).toBeGreaterThan(0);
    expect(EMAIL_ENGAGEMENT_WINDOW_MS).toBe(EMAIL_ENGAGEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    expect(recovery.length).toBeGreaterThan(2000);
    expect(recovery).toContain(`within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment`);
  });

  it("and the source INTERPOLATES it rather than restating the number", () => {
    // A page reading "14 days" because somebody typed 14 satisfies any output
    // check and drifts the day the constant moves. This is the same reason the
    // decline-category count is derived at its carriers.
    const src = read("app/lib/marketing/docs-content.ts");
    expect(src).toContain("${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment");
    expect(src).toContain('from "~/lib/constants"');
  });

  it("the copy says what happens OUTSIDE the window, not only inside it", () => {
    // The half a merchant needs: a late click is not a lost recovery, it is a
    // free one. Without this the rule reads as Foxhound declining to record.
    expect(recovery).toContain("Stripe's own baseline");
    expect(recovery.toLowerCase()).toContain("free");
  });
});

describe("PLANT 2: the suspect-click rule is stated and derived", () => {
  const recovery = guideText("recovery");

  it("the sixty seconds comes from the constant", () => {
    expect(CLICK_SUSPECT_MIN_SECONDS).toBeGreaterThan(0);
    expect(recovery).toContain(`within ${CLICK_SUSPECT_MIN_SECONDS} seconds of the email being sent`);
    const src = read("app/lib/marketing/docs-content.ts");
    expect(src).toContain("${CLICK_SUSPECT_MIN_SECONDS} seconds");
  });

  it("both suspect tests are described, and the outcome is stated", () => {
    // 380 marks a click suspect on either test, so copy naming one would
    // describe a narrower guard than the one that ships.
    expect(recovery).toContain("on a link no human can see");
    // SHOWN and NOT BILLED, which is the pair that matters: a suppressed click
    // that vanished would look like Foxhound hiding a recovery.
    expect(recovery).toContain("shown on the ledger");
    expect(recovery).toContain("never billed");
  });
});

describe("PLANT 3: /pricing states the same rule", () => {
  const pricing = read("app/routes/pricing.tsx");

  it("the billable FAQ carries both halves, derived", () => {
    // Re-verified at a0c41ac: /pricing's FAQ did state the billable rule, and
    // stated it in the pre-380 form, so it needed the same correction.
    expect(pricing).toContain("${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment");
    expect(pricing).toContain("marks suspect");
    expect(pricing).toContain("never billed");
  });

  it("and it does not contradict the guide", () => {
    // Both surfaces describe one rule. If either drifts to a typed number this
    // fails, because only one of them can be right about a moved constant.
    expect(pricing).not.toContain("14 days before the payment");
    expect(read("app/lib/marketing/docs-content.ts")).not.toContain("14 days before the payment");
  });
});
