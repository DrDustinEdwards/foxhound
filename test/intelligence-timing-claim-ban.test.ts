// The APPROVED-DIFFERENCES Intelligence entry: no surface may say that
// Intelligence changes Recovery timing or feeds dispute triage. Recovery's
// schedule comes from the decline category alone (RECOVERY_SCHEDULES), and
// Disputes computes no triage. This test scans every public surface that
// described Intelligence, with code comments stripped so a comment that
// explains the ban does not trip it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRICING_CARDS, PRICING_FAQS } from "~/lib/marketing/pricing-copy";

const SURFACES = [
  "app/lib/marketing/pricing-copy.ts",
  "app/routes/pricing.tsx",
  "app/routes/files/llms.ts",
  "app/routes/files/llms-full.ts",
  "app/lib/marketing/products-hub.ts",
  "app/routes/products/index.tsx",
  "app/lib/marketing/docs-content.ts",
  "app/lib/marketing/intelligence-copy.ts",
  "app/routes/products/intelligence.tsx",
];

/** Source text with line and block comments removed. */
function withoutComments(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const BANNED: RegExp[] = [
  /Recovery timing and Disputes triage/i,
  /Disputes triage/i,
  /(signals?|Intelligence|risk[- ]scoring layer)[^.]{0,60}\b(feeds?|improves?|informs?|changes?|adjusts?|tunes?)\b[^.]{0,30}Recovery timing/i,
  /\b(feeds?|improves?|informs?)\b[^.]{0,20}Recovery timing/i,
];

describe("no surface claims Intelligence changes Recovery timing or feeds dispute triage", () => {
  for (const path of SURFACES) {
    it(path, () => {
      const text = withoutComments(path);
      for (const re of BANNED) expect(text, `${path} matches ${re}`).not.toMatch(re);
    });
  }

  it("the /pricing Intelligence card and FAQ data carry no such claim", () => {
    const text = JSON.stringify({ PRICING_CARDS, PRICING_FAQS });
    for (const re of BANNED) expect(text).not.toMatch(re);
  });
});
