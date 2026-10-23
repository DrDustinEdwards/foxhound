
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget, type DocWidgetName } from "~/components/docs/doc-widgets";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { WATCH_CEILING, healthScoreBand } from "~/lib/intelligence/health-band";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

// SESSION 65: the audit, disputes and intelligence guides, and the preview
// widgets the session 65 walk ruled.
//
// THE WIDGETS ARE DERIVED, NOT TRANSCRIBED, and that is what these plants pin.
// A picture of four decline categories beside a six-key engine is the same
// defect Foxhound's own four-categories sentence carried until part one, so
// every widget that shows a set reads it from the constant the engine owns.

function flatten(blocks: DocBlock[]): string {
  const inline = (node: DocInline): string => {
    if (typeof node === "string") return node;
    if ("code" in node) return node.code;
    if ("strong" in node) return node.strong;
    if ("mono" in node) return node.mono;
    if ("badge" in node) return String(node.badge);
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

function textOf(slug: string): string {
  const guide = DOC_GUIDES.find((g) => g.slug === slug)!;
  return guide.sections.map((s) => `${s.heading}\n${flatten(s.body)}`).join("\n");
}

function renderWidget(name: DocWidgetName): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocWidget, { name })),
  );
}


const DISPUTES = textOf("disputes");
const INTELLIGENCE = textOf("intelligence");

describe("PLANT 2: the widgets draw what the engine computes", () => {

  it("HEALTH BANDS: Foxhound's cutoffs, and the picture agrees with the scorer", () => {
    const html = renderWidget("health-bands");
    expect(html).toContain(`Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`);
    expect(html).toContain(`${WATCH_CEILING} and above`);
    // The claim under the picture is that a 38 is at risk here and would be
    // watch on legacy. Asserted against the real scorer rather than the label.
    expect(healthScoreBand(38)).toBe("at_risk");
    expect(healthScoreBand(WATCH_CEILING)).toBe("healthy");
    expect(html).not.toContain("0-33");
  });
});

describe("PLANT 3: every capability sentence, tied to its code", () => {

  it("DISPUTES: the approval gate is described as enforced, and it is", () => {
    expect(DISPUTES).toContain(
      "The approval step is enforced by the database, not by a setting.",
    );
    // The six states, with approved between pending_review and submitted, are
    // the enforcement. A state set that let submitted follow pending_review
    // directly would make the sentence false.
    const order = Object.keys(DISPUTE_STATE_LABELS);
    expect(order.indexOf("approved")).toBeGreaterThan(order.indexOf("pending_review"));
    expect(order.indexOf("submitted")).toBeGreaterThan(order.indexOf("approved"));
  });

  it("DISPUTES: the cap sentence carries the real number, per 359 binding 3", () => {
    expect(DISPUTES).toContain("capped at $500 per dispute");
  });

  it("INTELLIGENCE: the paid layer, and no free tier the gate contradicts", () => {
    // J73: every Intelligence page is gated by isIntelligenceEntitled, so the
    // "at no charge" sentence was false of the product and is cut.
    expect(INTELLIGENCE).not.toContain("at no charge");
    expect(INTELLIGENCE).toContain("Intelligence is the paid layer, at $199 per month");
    // And the truthful qualifier: it is granted, not buyable.
    expect(INTELLIGENCE).toContain("There is no self-serve checkout for it yet");
  });
});
