import {
  AI_SEARCH_BOTS,
  AI_TRAINING_BOTS,
  DENIED_BOTS,
  SEARCH_ENGINE_BOTS,
} from "@drdustinedwards/site-helpers/robots";
import { describe, expect, it } from "vitest";

import { DISALLOW_PATHS, siteFiles } from "~/lib/seo/files";

// A crawler matching a named group uses only that group, so every named group must repeat the
// wildcard's disallows. /e/c/:token writes a billable click, so a crawler must never follow it.
// Parsed from the real /robots.txt the site answers, not from the constants that feed it.

const ALLOWED_BOTS = [...SEARCH_ENGINE_BOTS, ...AI_SEARCH_BOTS, ...AI_TRAINING_BOTS];
const RENDERED = await (await siteFiles(new Request("https://foxhoundapp.com/robots.txt")))!.text();

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

describe("every named group carries the wildcard's disallow set", () => {
  it("the parse found the groups at all, so a parse failure cannot read as a pass", () => {
    // An empty map would satisfy every `for` loop below.
    expect(GROUPS.size).toBe(1 + ALLOWED_BOTS.length + DENIED_BOTS.length);
    expect(GROUPS.has("*")).toBe(true);
    expect(DISALLOW_PATHS.length).toBeGreaterThan(20);
  });

  it("every allowed bot's group equals the wildcard's", () => {
    const wildcard = GROUPS.get("*")!;
    for (const bot of ALLOWED_BOTS) {
      expect(GROUPS.get(bot), `${bot} has no group`).toBeDefined();
      expect(GROUPS.get(bot), `${bot} does not match the wildcard group`).toEqual(wildcard);
    }
  });
});

describe("what the disallow set must and must not contain", () => {
  it("the billable click path and the other token-signed paths are excluded from every group", () => {
    for (const [name, directives] of GROUPS) {
      if (name === "Bytespider") continue;
      for (const path of ["/e/", "/u/", "/p/"]) {
        expect(directives, `${name} may crawl ${path}`).toContain(`Disallow: ${path}`);
      }
    }
  });
});
