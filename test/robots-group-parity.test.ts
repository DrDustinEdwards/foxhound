import {
  AI_SEARCH_BOTS,
  AI_TRAINING_BOTS,
  CONTENT_SIGNAL,
  DENIED_BOTS,
  SEARCH_ENGINE_BOTS,
} from "@drdustinedwards/site-helpers/robots";
import { describe, expect, it } from "vitest";

import { DISALLOW_PATHS, siteFiles } from "~/lib/seo/files";

// Per Google's robots.txt documentation, a crawler matching a named group uses
// ONLY that group, so a named group must repeat the wildcard's disallows or it
// replaces them. Money: /e/c/:token writes recovery_steps.clicked_at, an
// `email_engaged` billable signal, so a crawler following a pasted dunning link
// could record a click no human made.
//
// Parsed from the real /robots.txt the site answers, not from the constants that
// feed it, so a renderer change fails here with every constant untouched.

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

  it("the wildcard group is the content signal, Allow and every disallow", () => {
    expect(GROUPS.get("*")).toEqual([
      `Content-Signal: ${CONTENT_SIGNAL}`,
      "Allow: /",
      ...DISALLOW_PATHS.map((p) => `Disallow: ${p}`),
    ]);
  });

  it("every allowed bot's group equals the wildcard's", () => {
    const wildcard = GROUPS.get("*")!;
    for (const bot of ALLOWED_BOTS) {
      expect(GROUPS.get(bot), `${bot} has no group`).toBeDefined();
      expect(GROUPS.get(bot), `${bot} does not match the wildcard group`).toEqual(wildcard);
    }
  });

  it("Bytespider stays denied", () => {
    expect(DENIED_BOTS).toEqual(["Bytespider"]);
    expect(GROUPS.get("Bytespider")).toEqual(["Disallow: /"]);
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

  it("docs and marketing pages stay crawlable", () => {
    // A too-broad list pasted into every group would silently undo AI citation.
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
});

describe("the file a crawler receives", () => {
  it("ends with the sitemap line, outside every group", () => {
    expect(RENDERED.trimEnd().endsWith("Sitemap: https://foxhoundapp.com/sitemap.xml")).toBe(true);
  });
});
