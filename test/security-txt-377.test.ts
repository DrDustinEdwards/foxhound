import { describe, expect, it } from "vitest";

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
});
