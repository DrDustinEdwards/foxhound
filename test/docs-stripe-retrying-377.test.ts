import { describe, expect, it } from "vitest";

import { RECOVERABLE_FAILED_PAYMENT_STATUSES } from "~/lib/constants";
import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";
import { FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";

// 377(1) AND 380: THE TWO SMART RETRIES SENTENCES ARE NOW TRUE, AND THE STATUS
// VOCABULARY GAINS THE STATE THAT MADE THEM TRUE.
//
// The docs claimed for months that Foxhound starts after Stripe's own Smart
// Retries have run and failed, while intake spawned the sequence on the FIRST
// invoice.payment_failed. 376(2)(c) recorded the copy as the intent and the code
// as the defect, 377(1) ruled the split, and 380 shipped it: the first failure
// creates the row in `stripe_retrying` with no steps planned, and steps are
// planned when Stripe gives up.
//
// So docs-content.ts:84 STAYS, unchanged, because it is now a true sentence
// about shipped behaviour rather than a promise. What changed is the
// troubleshooting line beside it, which told a merchant their payment "will not
// appear" while Stripe is still trying. Since 380 it appears immediately, in a
// state of its own, and the old line would have sent somebody hunting for a
// missing payment that is on the page in front of them.
//
// THE PLANT TIES THE DOCS TO THE CODE'S OWN LABEL rather than pinning a phrase:
// the word a merchant reads in the guide is the word the app renders, read from
// FAILED_PAYMENT_STATUS_LABELS, so the two cannot drift.

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

describe("PLANT 1: the status vocabulary carries the shipped state", () => {
  it("THE GUIDE USES THE APP'S OWN LABEL, derived not transcribed", () => {
    const label = FAILED_PAYMENT_STATUS_LABELS.stripe_retrying;
    // The reader, mutated: an empty or missing label would make the assertion
    // below vacuous (379 binding 3).
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(3);

    const recovery = guideText("recovery");
    expect(recovery.length).toBeGreaterThan(2000);
    expect(recovery, "the guide does not use the app's label").toContain(label);
  });

  it("and the status LIST names it beside the others", () => {
    const recovery = guideText("recovery");
    // The four that were already there stay: adding a state must not quietly
    // drop one.
    for (const word of ["active", "recovered", "cancelled", "failed unrecovered"]) {
      expect(recovery.toLowerCase(), `${word} left the vocabulary`).toContain(word);
    }
    expect(recovery.toLowerCase()).toContain("stripe retrying, active, recovered");
    // AND THE DEFINITION, not only the summary line. Naming a status in the
    // one-line list while deleting the entry that explains it leaves a word a
    // merchant cannot look up, and the first cut of this plant passed while
    // exactly that was done to it.
    expect(recovery).toContain("Stripe is still attempting the payment on its own schedule");
    expect(recovery).toContain("has planned no steps yet");
  });

  it("the state it describes is the one the engine actually parks payments in", () => {
    // 380 ratified `stripe_retrying` into RECOVERABLE_FAILED_PAYMENT_STATUSES so
    // a payment that succeeds while parked is still recorded. If that state ever
    // leaves the engine, this guide sentence becomes fiction.
    expect(RECOVERABLE_FAILED_PAYMENT_STATUSES).toContain("stripe_retrying");
  });
});

describe("PLANT 2: the troubleshooting line matches shipped behaviour", () => {
  const recovery = guideText("recovery");

  it("it no longer says the payment will not appear", () => {
    // THE SUBSTRING IS THE CLAIM: this sentence is the false statement itself,
    // and since 380 the payment appears immediately.
    expect(recovery).not.toContain("the payment will not appear");
    expect(recovery).not.toContain("Foxhound only gets the webhook once Stripe has given up");
  });

  it("it says what happens instead, in 377(1)'s own words", () => {
    expect(recovery).toContain("The payment appears as soon as it fails, marked as Stripe's to retry");
    expect(recovery).toContain("Foxhound's sequence starts when Stripe stops");
  });
});

describe("PLANT 3: the sentence 377(1) said to KEEP is still there", () => {
  it("docs-content.ts:84 is unchanged and now true", () => {
    // 377(1) named this sentence specifically as one that becomes true rather
    // than one that changes. A session tidying nearby copy must not take it.
    expect(guideText("platform")).toContain(
      "Foxhound starts after Stripe's own Smart Retries have run and failed",
    );
  });
});
