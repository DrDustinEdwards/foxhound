// The APPROVED-DIFFERENCES Intelligence entry: no surface may say that
// Intelligence improves Recovery timing or feeds dispute triage. Failed-payment
// retries and emails follow the decline category alone (RECOVERY_SCHEDULES),
// and Disputes computes no triage. Intelligence DOES change one timing: on an
// account with Intelligence, win-back step 1 is delayed for every customer not
// flagged winback_priority (process.ts resolveWinbackStep1Offset, legacy
// parity). So "never changes a sequence" is banned too, and the true win-back
// sentence (winback-copy.ts) must pass. This test scans every public surface
// that describes Intelligence, with code comments stripped so a comment that
// explains the ban does not trip it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRICING_CARDS, PRICING_FAQS } from "~/lib/marketing/pricing-copy";
import { INTELLIGENCE_WINBACK_SENTENCE } from "~/lib/marketing/winback-copy";
import { INTELLIGENCE_FAQS } from "~/lib/marketing/intelligence-copy";

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
  // False since the win-back gate: Intelligence does change one sequence.
  /never changes a (recovery )?sequence/i,
  /Recovery's timing comes from the decline category alone/i,
];

describe("no surface claims Intelligence changes Recovery timing or feeds dispute triage", () => {
  for (const path of SURFACES) {
    it(path, () => {
      const text = withoutComments(path);
      for (const re of BANNED) expect(text, `${path} matches ${re}`).not.toMatch(re);
    });
  }

  it("the true win-back sentence passes the ban, and the Intelligence FAQ carries it", () => {
    for (const re of BANNED) expect(INTELLIGENCE_WINBACK_SENTENCE).not.toMatch(re);
    const faqs = JSON.stringify(INTELLIGENCE_FAQS);
    expect(faqs).toContain(JSON.stringify(INTELLIGENCE_WINBACK_SENTENCE).slice(1, -1));
    for (const re of BANNED) expect(faqs).not.toMatch(re);
  });

  it("the /pricing Intelligence card and FAQ data carry no such claim", () => {
    const text = JSON.stringify({ PRICING_CARDS, PRICING_FAQS });
    for (const re of BANNED) expect(text).not.toMatch(re);
  });
});
