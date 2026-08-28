import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STAT_AS_OF,
  STAT_SOURCES,
  STRIPE_RECOVERY_RATE_PERCENT,
  STRIPE_UNRECOVERED_RATE_PERCENT,
} from "~/lib/marketing/statistics";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");

// 377(9): EVERY STATISTIC CARRIES AN EXACT URL AND AN AS-OF DATE.
//
// The page said 56% citing stripe.com/billing, and stripe.com/billing had come
// to read 55%. That is the whole argument for the date: the claim was true when
// written, the citation still pointed at the right page, and nothing in the repo
// could tell that the number underneath it had moved. Grok caught the drift;
// 377(9) ruled the correction and the citation standard together.
//
// ALL THREE NUMBERS WERE RE-READ FROM THE LIVE SOURCES IN THIS SESSION rather
// than carried from the ruling: stripe.com/billing renders "recover 55% of
// failed payments on average"; the Smart Retries post renders "Twenty-five
// percent of lapsed subscriptions are purely due to payment failures" and
// "recovered by Stripe tools, continue on average for seven more" months.

describe("PLANT 1: the rate is 55 and it is derived", () => {
  it("the constant is 55 and its complement is derived from it", () => {
    expect(STRIPE_RECOVERY_RATE_PERCENT).toBe(55);
    // The old copy said 56 and 44, which summed correctly and was wrong twice.
    // Deriving the complement means the pair cannot be edited apart again.
    expect(STRIPE_UNRECOVERED_RATE_PERCENT).toBe(45);
    expect(STRIPE_RECOVERY_RATE_PERCENT + STRIPE_UNRECOVERED_RATE_PERCENT).toBe(100);
  });

  it("home carries the derived pair and no longer says 56", () => {
    const home = read("app/routes/home.tsx");
    expect(home.length).toBeGreaterThan(2000);
    expect(home).toContain(`${STRIPE_RECOVERY_RATE_PERCENT}%`);
    expect(home).toContain(`${STRIPE_UNRECOVERED_RATE_PERCENT}%`);
    // THE SUBSTRING IS THE CLAIM: 56% and 44% are the two false numbers.
    expect(home).not.toContain("56%");
    expect(home).not.toContain("44%");
  });

  it("the calculator too, and it no longer hardcodes the rate", () => {
    const calc = read("app/components/recovery-calculator.tsx");
    expect(calc).not.toContain("0.56");
    expect(calc).not.toContain("56%");
    expect(calc).toContain("STRIPE_RECOVERY_RATE_PERCENT");
  });
});

describe("PLANT 2: every statistic is dated and exactly sourced", () => {
  const home = read("app/routes/home.tsx");

  it("the as-of date is rendered beside the source", () => {
    expect(STAT_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(home).toContain("read {item.asOf}");
    expect(home).toContain("STAT_AS_OF");
  });

  it("NO STATISTIC IS CITED TO A BARE DOMAIN", () => {
    // 376 item 22's finding: the hero statistics pointed at "stripe.com/blog",
    // which is a publication and not a page. A reader cannot check it and
    // neither can the next session.
    expect(home).not.toContain('source: "stripe.com/blog"');
    expect(home).toContain(STAT_SOURCES.stripeSmartRetries.replace("https://", ""));
  });

  it("both cited URLs are exact pages, not domains", () => {
    for (const url of Object.values(STAT_SOURCES)) {
      expect(url.startsWith("https://")).toBe(true);
    }
    // The Smart Retries post is a path, not a bare host.
    expect(STAT_SOURCES.stripeSmartRetries).toContain("/blog/");
    expect(STAT_SOURCES.stripeSmartRetries.split("/").length).toBeGreaterThan(4);
  });
});

describe("PLANT 3: the calculator's share is the visitor's assumption", () => {
  const calc = read("app/components/recovery-calculator.tsx");

  it("it is an input the visitor sets, not a constant", () => {
    // 377(9): the 52% stays only as a visitor-editable input labelled as an
    // assumption. Hardcoded, it was a Foxhound recovery rate in everything but
    // name, because every visitor saw the same number and it was ours.
    expect(calc).toContain("recovery-share-slider");
    expect(calc).toContain('type="range"');
    expect(calc).not.toContain("0.52");
    // THE STATE HOOK ITSELF, not just the setter's name. The first cut of this
    // plant asserted "setRecoveryShare" appears, and a mutation that replaced
    // the hook with a constant plus a no-op setter of the same name passed it:
    // the slider rendered, the handler existed, and the value could not move.
    expect(calc).toContain("useState(DEFAULT_ASSUMED_RECOVERY_SHARE)");
    expect(calc).toContain("const [recoveryShare, setRecoveryShare] = useState(");
    expect(calc).toContain("onChange={(e) => setRecoveryShare(Number(e.target.value))}");
  });

  it("and it is LABELLED as an assumption, in the docs' own position", () => {
    expect(calc).toContain("Assumed recovery of the remainder");
    expect(calc).toContain("an assumption you set, not a Foxhound result");
    expect(calc).toContain("Foxhound does not project a recovery rate");
  });
});
