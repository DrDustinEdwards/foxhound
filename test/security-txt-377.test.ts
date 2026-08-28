import { describe, expect, it } from "vitest";

import { classifyPath } from "~/lib/http/cache-policy";
import {
  buildSecurityTxt,
  SECURITY_TXT_EXPIRES_DAYS,
  SECURITY_TXT_MAX_EXPIRES_DAYS,
} from "~/routes/files/security-txt";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";

// 377 ITEM 11: /.well-known/security.txt, RFC 9116.
//
// The file exists so that somebody who finds a vulnerability has a route to
// report it that is not a public post. Its one perishable field is `Expires`,
// which the spec makes mandatory precisely because a stale contact address is
// worse than none: a finder trusts it and gets silence.
//
// THIS PLANT IS BUILT TO FAIL BEFORE THE FILE DOES. The window is asserted
// against the spec's ceiling and the assertion message says what to change, so
// the suite goes red while the served file is still valid rather than after a
// finder has already been ignored.

const URL_BASE = "https://foxhoundapp.com";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse the file into fields, the way a consumer of the spec would. */
function fields(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    expect(at, `line has no field separator: ${line}`).toBeGreaterThan(0);
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

describe("PLANT 1: the required fields are present and parse", () => {
  const text = buildSecurityTxt(URL_BASE, new Date("2026-08-28T00:00:00.000Z"));
  const f = fields(text);

  it("Contact is the support mailbox, as a mailto", () => {
    expect(f.get("Contact")).toEqual([`mailto:${SUPPORT_EMAIL}`]);
    // Derived from the constant, so the file cannot outlive a change of address.
    expect(SUPPORT_EMAIL).toContain("@");
  });

  it("Policy points at the security page and Canonical at the file itself", () => {
    expect(f.get("Policy")).toEqual([`${URL_BASE}/security`]);
    // SELF-REFERENTIAL ON PURPOSE: Canonical says which copy is authoritative,
    // so a mirror found elsewhere is recognisable as a copy rather than as a
    // second contact route somebody could forge.
    expect(f.get("Canonical")).toEqual([`${URL_BASE}/.well-known/security.txt`]);
  });

  it("every line is a field, and the file ends with a newline", () => {
    expect(text.endsWith("\n")).toBe(true);
    for (const key of f.keys()) {
      expect(key, `${key} is not a bare field name`).not.toContain(" ");
    }
    expect([...f.keys()]).toContain("Expires");
  });
});

describe("PLANT 2: Expires parses, and is under the spec's ceiling", () => {
  it("THE DATE PARSES AND IS IN THE FUTURE, derived at test time", () => {
    // Derived from the clock the test runs on rather than a fixture, so this
    // exercises the same arithmetic a request will.
    const now = new Date();
    const f = fields(buildSecurityTxt(URL_BASE, now));
    const raw = f.get("Expires")?.[0];
    expect(raw, "Expires is missing").toBeDefined();

    const expires = new Date(raw!);
    expect(Number.isNaN(expires.getTime()), `Expires does not parse: ${raw}`).toBe(false);
    expect(expires.getTime()).toBeGreaterThan(now.getTime());
    // RFC 9116 wants a full ISO timestamp, not a bare date.
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("IT IS UNDER 366 DAYS OUT, and this is the assertion that ages", () => {
    const now = new Date();
    const raw = fields(buildSecurityTxt(URL_BASE, now)).get("Expires")![0];
    const days = (new Date(raw).getTime() - now.getTime()) / DAY_MS;

    expect(
      days,
      `security.txt Expires is ${Math.round(days)} days out, past RFC 9116's under-a-year ` +
        `recommendation. Lower SECURITY_TXT_EXPIRES_DAYS in app/routes/files/security-txt.ts.`,
    ).toBeLessThan(SECURITY_TXT_MAX_EXPIRES_DAYS);
    expect(days).toBeGreaterThan(0);
  });

  it("the configured window itself is inside the ceiling, with margin", () => {
    // The window is what a maintainer edits; the served date is a consequence.
    // Asserting both means a change to the constant fails here rather than
    // silently shipping a file that is out of spec on the day it is deployed.
    expect(SECURITY_TXT_EXPIRES_DAYS).toBeLessThan(SECURITY_TXT_MAX_EXPIRES_DAYS);
    expect(SECURITY_TXT_MAX_EXPIRES_DAYS).toBeLessThanOrEqual(366);
    // At least a month of margin, so a slow deploy cadence cannot push a served
    // file past the ceiling between deploys.
    expect(SECURITY_TXT_MAX_EXPIRES_DAYS - SECURITY_TXT_EXPIRES_DAYS).toBeGreaterThanOrEqual(28);
  });

  it("a file built a year ago would ALREADY be failing, which is the point", () => {
    // The guard is only worth having if it discriminates on age. Building with
    // a clock from a year back must produce an Expires in the past.
    const stale = new Date(Date.now() - 400 * DAY_MS);
    const raw = fields(buildSecurityTxt(URL_BASE, stale)).get("Expires")![0];
    expect(new Date(raw).getTime()).toBeLessThan(Date.now());
  });
});

describe("PLANT 3: it is served as a files route", () => {
  it("the path classifies as `files`, not `private`", () => {
    // Everything unmatched in cache-policy is private, so a new route is
    // uncached until somebody lists it. This asserts it was listed.
    expect(classifyPath("/.well-known/security.txt")).toBe("files");
  });

  it("and an unrelated well-known path is still private", () => {
    // The discriminator: the entry is the exact file, not a prefix that would
    // quietly make every future .well-known route public.
    expect(classifyPath("/.well-known/anything-else")).toBe("private");
  });
});
