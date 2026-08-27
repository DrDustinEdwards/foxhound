import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
/** Source with runs of whitespace collapsed to one space.
 *
 *  JSX WRAPS SENTENCES ACROSS LINES, and the prettier-formatted source breaks
 *  "read-only Stripe connection" over a newline plus twelve spaces of indent. A
 *  raw substring check therefore fails on a sentence that renders perfectly,
 *  which is a false negative about the page rather than a finding about it. The
 *  browser collapses this whitespace and so does this reader. */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    // COMMENTS COME OUT FIRST, and session 57's trap is why: the JSX comment
    // beside the fixed line QUOTES the sentence it replaced, in order to explain
    // what was wrong with it, so an absence check over raw source finds the
    // defect inside its own explanation. This suite walked straight into it on
    // its first run, which the campaign has now recorded four times.
    // Only BLOCK comments are stripped, and that is deliberate: the naive
    // line-comment stripper eats every https:// in a file, which this repo has
    // recorded as its own trap. The quoted sentence lives in a JSX block
    // comment, so the block form is all this needs.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");

// 376 ITEM 20: THE CTA CONTRADICTION ON /pricing.
//
// The closing block said "Connect Stripe for a free diagnostic", put a button
// reading "Connect Stripe, it is free" under it, and then reassured the reader
// with "No Stripe connection needed" on the same screen. Verified at 2569400 at
// pricing.tsx:213 and :223.
//
// NEITHER HALF WAS FALSE, WHICH IS WHY IT SURVIVED. They are true of two
// different products: the no-auth estimator takes an MRR figure and a customer
// count and needs no connection at all, and the full audit is a read-only Stripe
// OAuth connection. PRICING.md's Audit section describes exactly this pair. The
// page put both sentences on one screen without saying which was which, so a
// reader had to guess whether connecting was required.
//
// The reassurance line now names the two products. Class (c) truthfulness under
// 362, no ratification needed, and the fix is words inside the same element:
// same div, same middot separators, same position. The parity ledger owns
// layout and treatment and neither moved.

describe("PLANT 1: the contradiction is gone from /pricing", () => {
  const pricing = read("app/routes/pricing.tsx");

  it("the bare contradiction no longer appears", () => {
    expect(pricing.length).toBeGreaterThan(1000);
    // THE SUBSTRING IS THE CLAIM here: this exact sentence, sitting under a
    // Connect Stripe button, IS the defect 376 item 20 recorded.
    expect(pricing).not.toContain("No Stripe connection needed");
  });

  it("and both products are named, so the reader is not left guessing", () => {
    expect(pricing).toContain("Estimator: no account, no Stripe connection");
    expect(pricing).toContain("Full audit: read-only Stripe connection");
  });

  it("READ-ONLY is stated, which is a ruled claim and not decoration", () => {
    // 362 ruling 1: the audit's OAuth requests read-only scope, full stop, and
    // the published sentence "The audit only reads" was made provable with a
    // plant against the scope parameter. The reassurance line must not drift
    // away from that word.
    expect(pricing).toContain("read-only Stripe connection");
  });

  it("the button copy is untouched, as the brief required", () => {
    expect(pricing).toContain("Connect Stripe, it is free");
  });
});

describe("PLANT 2: home does NOT carry the same collision", () => {
  // 376 item 20 says "home carries the same collision". Measured at 2569400: it
  // does not, and `git log -S` finds the string has never been in home.tsx at
  // any commit. Home's closing block reads "Connect Stripe for a free
  // diagnostic" with "No account required . Results in 30 seconds . Disconnect
  // anytime", which is consistent: no FOXHOUND account is required, and that is
  // a different claim from no Stripe connection.
  //
  // Recorded as a test rather than only in a commit message so the next session
  // reading item 20 does not go looking for a defect that is not there, and so
  // that if somebody later adds the line to home it fails here.
  const home = read("app/routes/home.tsx");

  it("home has no no-connection claim to contradict its Connect Stripe button", () => {
    expect(home.length).toBeGreaterThan(1000);
    expect(home).not.toContain("No Stripe connection needed");
    // The positive control: home really does carry the button the collision
    // would have contradicted, so this is not passing because the block moved.
    expect(home).toContain("Connect Stripe for a free diagnostic");
    expect(home).toContain("No account required");
  });
});
