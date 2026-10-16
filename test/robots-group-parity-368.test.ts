import { describe, expect, it } from "vitest";

import {
  ALLOWED_BOTS,
  DENIED_BOTS,
  DISALLOW_PATHS,
  buildRobotsTxt,
} from "~/routes/files/robots";

// RULING 368 RULING 1: THE SIXTEEN NAMED GROUPS CARRIED A BARE `Allow: /`.
//
// THE RULE THIS RESTS ON, verified against Google's own robots.txt
// documentation rather than asserted from memory: "User agent specific groups
// and global groups (`*`) are not combined." A crawler matching a named group
// uses ONLY that group. So sixteen groups carrying `Allow: /` and nothing else
// were not narrowing the wildcard, they were REPLACING it, and Googlebot,
// Bingbot, GPTBot, ClaudeBot and twelve others were invited into every path the
// wildcard excludes.
//
// WHY IT IS MONEY AND NOT HYGIENE. The authenticated paths redirect to login and
// were never a leak. `/e/` was the one that mattered: `/e/c/:token` writes
// `recovery_steps.clicked_at`, `findAttributionSignals` reads that as the
// `email_engaged` signal, and `email_engaged` is in `BILLABLE_ATTRIBUTION_KINDS`.
// A crawler following a pasted dunning link could record a click no human made,
// one step from an invoice.
//
// THE PLANT IS DERIVED FROM THE RENDERED FILE, not from the constants that feed
// it. It parses the real output of `buildRobotsTxt` into groups the way a
// crawler would, so a change to the RENDERER (a dropped loop, a reordered push,
// a group emitted without its disallows) fails here even though every constant
// is untouched. Asserting `DISALLOW_PATHS.length` against itself would have
// passed against the exact bug this fixes.

const RENDERED = buildRobotsTxt("https://foxhoundapp.test");

/** Parse robots.txt the way a crawler groups it: a run of `User-agent:` lines
 *  followed by that group's directives, ending at the blank line. */
function parseGroups(text: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      current = null;
      continue;
    }
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (field.toLowerCase() === "user-agent") {
      current = [];
      groups.set(value, current);
      continue;
    }
    if (current) current.push(`${field}: ${value}`);
  }
  return groups;
}

const GROUPS = parseGroups(RENDERED);

describe("PLANT 1: every named group carries the wildcard's disallow set", () => {
  it("the parse found the groups at all, so a parse failure cannot read as a pass", () => {
    // The non-vacuous floor. An empty map would satisfy every `for` loop below.
    expect(GROUPS.size).toBe(1 + ALLOWED_BOTS.length + DENIED_BOTS.length);
    expect(GROUPS.has("*")).toBe(true);
    expect(DISALLOW_PATHS.length).toBeGreaterThan(20);
  });

  it("the WILDCARD group is Allow plus every disallow, in order", () => {
    expect(GROUPS.get("*")).toEqual([
      "Allow: /",
      ...DISALLOW_PATHS.map((p) => `Disallow: ${p}`),
    ]);
  });

  it("EVERY ALLOWED BOT'S GROUP EQUALS THE WILDCARD'S, exactly", () => {
    // PARAMETERIZED OVER THE CONSTANT, so a seventeenth bot added later is
    // covered without anyone remembering to add a case. That is the property the
    // old file lacked: nothing tied a new named group to the disallow set.
    const wildcard = GROUPS.get("*")!;
    for (const bot of ALLOWED_BOTS) {
      expect(GROUPS.get(bot), `${bot} has no group`).toBeDefined();
      expect(GROUPS.get(bot), `${bot} does not match the wildcard group`).toEqual(wildcard);
    }
  });

  it("and NO allowed group is a bare Allow, which is the bug in its own words", () => {
    for (const bot of ALLOWED_BOTS) {
      expect(GROUPS.get(bot), `${bot} is a bare allow again`).not.toEqual(["Allow: /"]);
    }
  });

  it("BYTESPIDER STAYS DENIED, and is not swept up by the parity rule", () => {
    expect(DENIED_BOTS).toEqual(["Bytespider"]);
    expect(GROUPS.get("Bytespider")).toEqual(["Disallow: /"]);
  });
});

describe("PLANT 2: what the disallow set must and must not contain", () => {
  it("THE BILLABLE CLICK PATH IS EXCLUDED FROM EVERY GROUP, which is 368's point", () => {
    // The one path whose crawl writes a signal that can be invoiced. Asserted
    // per group rather than once, because per group is where it was missing.
    for (const [name, directives] of GROUPS) {
      if (name === "Bytespider") continue;
      expect(directives, `${name} may crawl /e/`).toContain("Disallow: /e/");
    }
  });

  it("and so are the other token-signed public paths", () => {
    for (const [name, directives] of GROUPS) {
      if (name === "Bytespider") continue;
      expect(directives, `${name} may crawl /u/`).toContain("Disallow: /u/");
      expect(directives, `${name} may crawl /p/`).toContain("Disallow: /p/");
    }
  });

  it("THE STRATEGY'S PAGES STAY CRAWLABLE, which the fix must not break", () => {
    // 368's bound: no robots Disallow of the docs or marketing paths. A parity
    // fix that pasted a too-broad list into sixteen groups would silently undo
    // the whole AI-citation strategy, so the absence is asserted rather than
    // assumed.
    const forbidden = ["/docs", "/blog", "/pricing", "/products", "/features", "/audit"];
    for (const [name, directives] of GROUPS) {
      if (name === "Bytespider") continue;
      for (const path of forbidden) {
        expect(directives, `${name} excludes ${path}`).not.toContain(`Disallow: ${path}`);
      }
    }
    // `/audit` bare must not appear, but its authenticated children must.
    expect(GROUPS.get("*")).toContain("Disallow: /audit/dashboard");
    expect(GROUPS.get("*")).not.toContain("Disallow: /audit");
  });

  it("every AI crawler 368 names is still ALLOWED, so the fix did not deny them", () => {
    for (const bot of [
      "GPTBot",
      "ChatGPT-User",
      "OAI-SearchBot",
      "ClaudeBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
      "Google-Extended",
      "Googlebot",
      "Bingbot",
      "CCBot",
    ]) {
      expect(ALLOWED_BOTS, `${bot} left the allow list`).toContain(bot);
      expect(GROUPS.get(bot), `${bot} lost its Allow`).toContain("Allow: /");
    }
  });
});

describe("PLANT 3: the file a crawler actually receives", () => {
  it("ends with the sitemap line, outside every group", () => {
    expect(RENDERED.trimEnd().endsWith("Sitemap: https://foxhoundapp.test/sitemap.xml")).toBe(true);
  });

  it("has no duplicate user-agent declaration, which would split a group", () => {
    const declared = RENDERED.split("\n")
      .filter((l) => l.toLowerCase().startsWith("user-agent:"))
      .map((l) => l.split(":")[1].trim());
    expect(new Set(declared).size).toBe(declared.length);
  });
});
