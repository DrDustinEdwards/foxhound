import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_WEBHOOK_EVENTS_DAYS,
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";
import { classifyPath } from "~/lib/http/cache-policy";
import { DENIED_TOOL_FRAGMENTS } from "~/lib/mcp/registry";
import { STATIC_PAGES } from "~/routes/files/sitemap";

const ROOT = new URL("../", import.meta.url);

/**
 * Source with BLOCK COMMENTS STRIPPED and whitespace collapsed (387).
 *
 * The module header explains at length that no attestation claim appears on this
 * page, and it names the claims it is refusing: SOC 2, penetration test,
 * bank-grade. An absence check over raw source would therefore find the forbidden
 * phrases inside the comment that forbids them, which is session 57's trap and
 * the fourth time this campaign has recorded it. Line comments are left alone
 * because the naive stripper eats every https:// in a file.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // LINE COMMENTS TOO, but only where the line STARTS with one, which is the
    // established shape in this repo: a blanket `//` strip eats every https:// in
    // a file. Lines are filtered BEFORE whitespace is collapsed, because
    // collapsing first destroys the line structure this depends on.
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ");

const page = read("app/routes/security.tsx");

describe("PLANT 2: every factual claim is pinned to what makes it true", () => {
  it("THE OAUTH SCOPES COME FROM THE CONSTANTS THE OAUTH CALLS SEND", () => {
    // Derived, not typed: if 362 ruling 1's read-only audit scope ever changed,
    // this page would be describing a permission Foxhound no longer requests.
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
    expect(STRIPE_CONNECT_SCOPE).toBe("read_write");
    expect(page).toContain("{STRIPE_AUDIT_SCOPE} scope");
    expect(page).toContain("{STRIPE_CONNECT_SCOPE} scope");
  });

  it("THE RETENTION WINDOWS COME FROM THE CONSTANTS THE SWEEPERS DELETE ON", () => {
    // EACH CLAIM PINS TO ITS OWN CONSTANT. Engagement and email sends happen to
    // share a window today, as do webhooks and AI calls, so one interpolation
    // could have covered two claims and gone silently wrong the day either
    // moved. Four claims, four constants.
    for (const days of [
      RETENTION_ENGAGEMENT_DAYS,
      RETENTION_EMAIL_SENDS_DAYS,
      RETENTION_WEBHOOK_EVENTS_DAYS,
      RETENTION_AI_CALLS_DAYS,
    ]) {
      expect(days).toBeGreaterThan(0);
    }
    expect(page).toContain("{RETENTION_ENGAGEMENT_DAYS} days");
    expect(page).toContain("{RETENTION_EMAIL_SENDS_DAYS} days");
    expect(page).toContain("{RETENTION_WEBHOOK_EVENTS_DAYS} days");
    expect(page).toContain("{RETENTION_AI_CALLS_DAYS}");
  });

  it("the never-exposed API actions match the MCP denylist", () => {
    // Same tie as the Terms carve-out: the page promises these are unavailable
    // to a key, and the registry is what makes that true.
    expect(DENIED_TOOL_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of ["submit_dispute", "disconnect", "connect_stripe", "record_outcome"]) {
      expect(DENIED_TOOL_FRAGMENTS, `${fragment} is not denied`).toContain(fragment);
    }
    expect(page).toContain("submitting dispute evidence, connecting or disconnecting Stripe");
  });
});

describe("PLANT 4: the page is reachable", () => {
  it("it is in the sitemap", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("/security");
    // Beside the other two legal pages, so a future tidy cannot drop one.
    expect(paths).toContain("/privacy");
    expect(paths).toContain("/terms");
  });
});

describe("PLANT 5: every page in the sitemap is publicly cacheable", () => {
  // THE GUARD THAT WOULD HAVE CAUGHT THIS ONE. /security shipped in the sitemap,
  // the footer and the route tree, and was served `private, no-store`, because
  // cache-policy classifies everything unlisted as private and nobody listed it.
  // Measured live before this test existed.
  //
  // DERIVED FROM STATIC_PAGES rather than listing the pages again: a public page
  // that a crawler is invited to index must not be uncacheable, and the next
  // page added is covered on the day it enters the sitemap.
  it("no STATIC_PAGES entry classifies as private", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      expect(classifyPath(path), `${path} is in the sitemap but served private`).not.toBe("private");
    }
  });

  it("and /security specifically is marketing, like /privacy and /terms", () => {
    expect(classifyPath("/security")).toBe("marketing");
    expect(classifyPath("/privacy")).toBe("marketing");
    expect(classifyPath("/terms")).toBe("marketing");
  });
});
