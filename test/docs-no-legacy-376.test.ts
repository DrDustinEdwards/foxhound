import { describe, expect, it } from "vitest";

import {
  DOC_GUIDES,
  type DocBlock,
  type DocInline,
} from "~/lib/marketing/docs-content";

// 376 ITEM 17: THE PREVIOUS PRODUCT'S NAME IS OUT OF THE CUSTOMER DOCS.
//
// The guides carried seven notes contrasting Foxhound with the product it
// replaced ("Legacy classified four categories", "Legacy submits automatically
// 24 hours before the deadline"). That contrast is real and it belongs in
// Capsid, where the porting decisions live. It does not belong on a page a
// merchant reads to learn how their billing works: they never used the previous
// product, have no way to check the comparison, and the word invites the
// question of what else changed.
//
// CLASS (c) TRUTHFULNESS AND BRANDING under 362 and 376, needing no parity
// ratification. Every sentence keeps its remaining truth; only the comparison
// leaves.
//
// ASSERTED OVER THE RENDERED TEXT, NOT THE SOURCE, and the distinction is the
// point of the file. This module's own header comments legitimately discuss the
// previous product, because they explain why the block vocabulary is shaped the
// way it is, and a source grep would either fail on those comments or be
// weakened to ignore them. What a merchant reads is the flattened block tree,
// so that is what is measured.

/** Flatten a guide's blocks to exactly the words that reach the page. */
function flatten(blocks: DocBlock[]): string {
  const inline = (node: DocInline): string => {
    if (typeof node === "string") return node;
    if ("code" in node) return node.code;
    if ("strong" in node) return node.strong;
    if ("mono" in node) return node.mono;
    return node.link;
  };
  const rich = (r: string | DocInline[]): string =>
    typeof r === "string" ? r : r.map(inline).join("");
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

function renderedText(slug: string): string {
  const guide = DOC_GUIDES.find((g) => g.slug === slug);
  if (!guide) throw new Error(`no guide ${slug}`);
  return [
    guide.title,
    guide.description,
    ...guide.sections.map((s) => `${s.heading}\n${flatten(s.body)}`),
  ].join("\n");
}

/** The words that must not reach a customer-facing guide. Both spellings,
 *  because the product had two names and the branding rule covers both. */
const FORBIDDEN = ["Legacy", "legacy", "Recova", "recova"];

describe("PLANT 1: no guide names the previous product", () => {
  it("EVERY GUIDE'S RENDERED TEXT IS CLEAN, swept over all five", () => {
    // DERIVED FROM DOC_GUIDES, not a list of five slugs: a sixth guide is
    // covered on the day it is added.
    expect(DOC_GUIDES.length).toBeGreaterThan(0);

    for (const guide of DOC_GUIDES) {
      const text = renderedText(guide.slug);
      for (const word of FORBIDDEN) {
        expect(text, `${guide.slug} still says "${word}"`).not.toContain(word);
      }
    }
  });

  it("the sweep is not vacuous: the guides have real text and the reader works", () => {
    // 383's rule. An absence assertion over empty strings passes for the wrong
    // reason, so the flattener is shown to actually produce the page's words.
    expect(DOC_GUIDES).toHaveLength(5);
    for (const guide of DOC_GUIDES) {
      expect(renderedText(guide.slug).length, `${guide.slug} rendered empty`).toBeGreaterThan(2000);
    }
    // THE OTHER READER. An empty FORBIDDEN list makes the sweep above run zero
    // assertions over five guides and pass, which is the same vacuum in the
    // other direction (379 binding 3 applied to both sides of the loop).
    expect(FORBIDDEN.length).toBeGreaterThan(0);
    expect(FORBIDDEN).toContain("Legacy");
    expect(FORBIDDEN).toContain("Recova");
    // And a positive control on the flattener itself: a known sentence from a
    // known guide comes through, so "not.toContain" is reading real content.
    expect(renderedText("platform")).toContain("Foxhound watches your connected Stripe account");
  });

  it("the sentences that carried the comparison kept their remaining truth", () => {
    // Removing a word must not remove the claim. Each of these is the surviving
    // half of a note that used to open with the previous product's name.
    const recovery = renderedText("recovery");
    expect(recovery).toContain("Foxhound classifies six categories");
    expect(recovery).toContain("no rewrite-the-pending-email control");

    const audit = renderedText("audit");
    expect(audit).toContain("Foxhound applies no flat recovery estimate to at-risk value");

    const disputes = renderedText("disputes");
    expect(disputes).toContain("no automatic-submission setting");

    const intelligence = renderedText("intelligence");
    expect(intelligence).toContain("same constant the engine scores with");
    expect(intelligence).toContain("no Recommended action column");
  });
});
