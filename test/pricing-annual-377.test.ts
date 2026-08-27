import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTELLIGENCE_PRICE_CENTS } from "~/lib/constants";

const ROOT = new URL("../", import.meta.url);
/** Source with block comments stripped and whitespace collapsed. The comment
 *  beside the fixed line names the term it removed, so a raw check would find
 *  the offer inside its own explanation (session 57's trap). */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");

// 377(8): THE ANNUAL TERM COMES OFF /pricing UNTIL A CHECKOUT EXISTS.
//
// The Intelligence card advertised "Annual billing: 10 months paid, 2 months
// free", verified at 2569400 at pricing.tsx:99. Nothing can sell or invoice it:
// the monthly billing run emits recovery_fee and dispute_fee lines, and an
// Intelligence subscription is admin-granted. An offer with no way to accept it
// fails the FTC's bona fide-offer test whatever the intent behind it, which is
// why this is truthfulness rather than a pricing change.
//
// PRICING rev 5 item 3 records the term as unchanged and merely off the page; it
// returns the day a purchase path ships. So this plant asserts the OFFER is
// absent, never that the term is dead.

describe("PLANT 1: the annual offer is off the page", () => {
  const pricing = read("app/routes/pricing.tsx");

  it("no advertised annual term remains", () => {
    expect(pricing.length).toBeGreaterThan(1000);
    // THE SUBSTRING IS THE CLAIM: this sentence IS the offer 377(8) removed.
    expect(pricing).not.toContain("Annual billing");
    expect(pricing).not.toContain("10 months paid");
    expect(pricing).not.toContain("2 months free");
  });

  it("and the card says how Intelligence is actually obtained today", () => {
    expect(pricing).toContain("Granted during early access; ask us");
  });

  it("THE $199 FIGURE IS UNTOUCHED, pinned to the constant not the string", () => {
    // 377(8) changed what the card offers, not what it costs. Derived from the
    // pricing constant so this cannot pass against a page that quietly moved the
    // number while removing the term.
    const dollars = INTELLIGENCE_PRICE_CENTS / 100;
    expect(dollars).toBe(199);
    expect(pricing).toContain(`$${dollars}`);
    expect(pricing).toContain(`$${dollars}/mo`);
  });
});
