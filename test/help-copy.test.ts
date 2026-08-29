import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { QUICK_ANSWERS } from "~/routes/app/help";

// Ruling 232's user-facing carrier, corrected under 394 halt 3, and now moved
// off the surface it used to watch.
//
// HISTORY THIS FILE MUST KEEP, because it has been wrong twice and both times
// in the direction of defending the defect:
//
//   1. Its premise block pinned `account_members_one_active_per_user_uq` as
//      current after migration 0018 had dropped it (ruling 397).
//   2. Its switcher check searched for the phrase "account switcher", which the
//      DENIAL sentence "the app has no account switcher" also contains, so it
//      passed on the exact copy it existed to prevent. A presence check on a
//      phrase is satisfied by the phrase's own negation.
//
// WHY THE TEAM-SECTION ASSERTIONS ARE GONE, stated rather than quietly dropped:
// session 90 job 4 ported /help toward legacy's REAL page,
// app/(app)/help/page.tsx, which carries no Team section and no account copy at
// all. Legacy's page is six question-and-answer pairs, a Guides grid, platform
// status and a contact block; account management is covered by the Platform
// guide the Guides section links to. So the SECTIONS array those assertions
// read no longer exists, and asserting over a deleted surface would be a test
// pinning the page shape this commit was told to change.
//
// WHAT SURVIVES IS THE INVARIANT, not the assertions: /help must not deny a
// control that ships, and must not promise one that does not. That is
// enforceable over whatever copy the page carries, so it is now enforced over
// ALL of it, read from source rather than from one exported constant, which
// also means a future section cannot escape the check by not being in an array
// this file imports.

const SOURCE = readFileSync(new URL("../app/routes/app/help.tsx", import.meta.url), "utf8");

/** The page's own rendered copy: every answer, plus the guide, connector and
 *  contact strings, read out of source. Comments are stripped first: ruling 387
 *  found an absence scan finding the forbidden text inside the comment that
 *  explained the replacement, and this file's own header names the denial
 *  sentence twice. Block comments only, because a naive line-comment stripper
 *  eats every https:// in the file. */
function renderedCopy(): string {
  const withoutBlockComments = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return withoutLineComments;
}

describe("help copy: the switcher denial can never come back", () => {
  it("reads a non-empty body of copy, so an absence check cannot pass on nothing", () => {
    // 392's rule: a scan asserts it parsed something. Without this, a rename of
    // the route file would make every assertion below vacuously green.
    const copy = renderedCopy();
    expect(copy.length).toBeGreaterThan(1000);
    expect(QUICK_ANSWERS.length).toBe(6);
  });

  it("denies the account switcher nowhere on the page", () => {
    expect(renderedCopy()).not.toMatch(/no account switcher/i);
  });

  it("asserts the revoked single-account rule nowhere on the page", () => {
    const copy = renderedCopy();
    expect(copy).not.toMatch(/single-account/i);
    expect(copy).not.toMatch(/one account at a time/i);
    expect(copy).not.toMatch(/belongs to one account/i);
    expect(copy).not.toMatch(/cannot create or switch/i);
  });

  it("promises nothing beyond what ships (20b, the other direction)", () => {
    for (const answer of QUICK_ANSWERS) {
      expect(answer.a).not.toMatch(/soon|coming|will be able|in future/i);
    }
  });
});

describe("help copy: every answer is a real question with a real answer", () => {
  it("has a question and a non-empty answer in every pair", () => {
    for (const answer of QUICK_ANSWERS) {
      expect(answer.q.length).toBeGreaterThan(0);
      expect(answer.q.endsWith("?")).toBe(true);
      expect(answer.a.length).toBeGreaterThan(0);
    }
  });

  it("names no AI vendor, which is a portfolio rule and not a parity question", () => {
    // capsid/conventions.md: never Claude, Anthropic, GPT or LLM in
    // user-facing copy. Legacy's MCP connector note says "For Claude.ai", so
    // this is a string the port would otherwise have carried across verbatim.
    expect(renderedCopy()).not.toMatch(/claude|anthropic|\bGPT\b|language model/i);
  });
});
