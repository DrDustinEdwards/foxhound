import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  DECLINE_CATEGORY_PHRASE,
} from "~/lib/marketing/decline-categories";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

// 376 ITEM 18: THE MARKETING COUNT EQUALS THE ENGINE'S COUNT.
//
// Four surfaces said "four decline categories" against an engine that ships six,
// verified at 2569400: pricing.tsx:61, home.tsx:64, features.tsx:188 and
// compare/competitors.ts:129. 359 found the same sentence in the DOCS a month
// earlier and fixed it by DERIVING the set from RECOVERY_SCHEDULES, so the docs
// have said six ever since while the marketing pages went on saying four.
//
// THAT IS THE LESSON THIS FILE IS SHAPED BY: fixing the number would have left
// the next session to find it again. The number is derived at every carrier now,
// and this guard compares the two lists rather than pinning either.

describe("PLANT 1: the marketing count is the schedule count", () => {
  it("DERIVED, not transcribed", () => {
    expect(DECLINE_CATEGORY_COUNT).toBe(Object.keys(RECOVERY_SCHEDULES).length);
    // And the engine's own two lists agree, so neither can drift under the copy.
    expect(DECLINE_CATEGORY_COUNT).toBe(DECLINE_CATEGORIES.length);
  });

  it("THE READER IS MUTATED: the derivation is non-empty and is really six today", () => {
    // 379 binding 3. A derivation returning zero would make every "equals the
    // schedule count" assertion below trivially true, and the copy could then
    // say anything at all.
    expect(DECLINE_CATEGORY_COUNT).toBeGreaterThan(0);
    expect(DECLINE_CATEGORY_COUNT).toBe(6);
    expect(DECLINE_CATEGORY_COUNT_WORD).toBe("Six");
    expect(DECLINE_CATEGORY_COUNT_WORD_LOWER).toBe("six");
  });

  it("the phrase names every scheduled category, in the schedule's own order", () => {
    const keys = Object.keys(RECOVERY_SCHEDULES);
    expect(keys.length).toBeGreaterThan(0);
    // Every key contributes a word, so a seventh category cannot be silently
    // dropped from the sentence.
    for (const key of keys) {
      const head = key === "unknown" ? "nothing has mapped" : key;
      expect(DECLINE_CATEGORY_PHRASE, `${key} is missing from the phrase`).toContain(head);
    }
    expect(DECLINE_CATEGORY_PHRASE).toContain(", or ");
  });
});

describe("PLANT 2: every marketing carrier derives the number", () => {
  // THE CARRIERS 376 ITEM 18 NAMED, checked at their source, because the arrays
  // live inside route modules that are not exported and importing a route to
  // read one string would pull the whole render tree in behind it.
  //
  // SOURCE IS THE RIGHT ARTIFACT HERE ANYWAY: what this guards is that the copy
  // INTERPOLATES the derived constant rather than restating its value, and a
  // rendered string cannot tell the two apart. A page reading "Six" because
  // somebody typed "Six" would satisfy any output check and drift on the day a
  // seventh category ships, which is exactly how "four" survived 359.
  const CARRIERS: { file: string; mustUse: string[] }[] = [
    // /pricing's card copy lives in lib/marketing/pricing-copy.ts since J54.
    { file: "app/lib/marketing/pricing-copy.ts", mustUse: ["DECLINE_CATEGORY_COUNT_WORD"] },
    {
      // /features' copy moved here with J60.
      file: "app/lib/marketing/features-content.ts",
      mustUse: ["DECLINE_CATEGORY_COUNT_WORD", "DECLINE_CATEGORY_PHRASE"],
    },
    { file: "app/lib/compare/competitors.ts", mustUse: ["DECLINE_CATEGORY_COUNT_WORD_LOWER"] },
    // Home's copy moved to lib/marketing/home-copy.ts with J59.
    { file: "app/lib/marketing/home-copy.ts", mustUse: ["DECLINE_CATEGORY_LIST_AND", "DECLINE_CATEGORY_COUNT_WORD"] },
  ];

  it("all four carriers interpolate the derived value", () => {
    expect(CARRIERS.length).toBe(4);
    for (const carrier of CARRIERS) {
      const src = read(carrier.file);
      expect(src.length, `${carrier.file} read empty`).toBeGreaterThan(500);
      for (const name of carrier.mustUse) {
        expect(src, `${carrier.file} does not use ${name}`).toContain(`\${${name}}`);
      }
    }
  });

  it("and none of them still states a count in words", () => {
    // The literal that was wrong for as long as the docs were right.
    for (const carrier of CARRIERS) {
      const src = read(carrier.file);
      expect(src.toLowerCase(), `${carrier.file} still hardcodes four`).not.toContain(
        "four decline categories",
      );
      expect(src.toLowerCase(), `${carrier.file} still hardcodes the old list`).not.toContain(
        "soft, network, expired, or fraud",
      );
    }
  });
});
