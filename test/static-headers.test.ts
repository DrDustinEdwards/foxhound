import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS } from "~/lib/http/security-headers";

// public/_headers hardcodes the security header set for static-asset responses,
// which the Worker never sees, so the same values live in two places by
// necessity: a static file cannot import a constant. conventions.md's rule for
// exactly this shape is that the duplicate gets a test deriving the expected
// list from the source of truth and failing in BOTH directions, so neither a
// missing entry nor an orphaned one can survive.
//
// Content-Security-Policy is excluded on purpose: it carries a per-request nonce
// and cannot be static (ruling 93 keeps that strength as class 2(a)). If a future
// edit adds a static CSP line to _headers, the orphan check below fails, which is
// the intended outcome.

const HEADERS_FILE = new URL("../public/_headers", import.meta.url);

/** Parse the `/*` block of a Cloudflare _headers file into name/value pairs. */
function parseGlobalBlock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inGlobal = false;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const isRule = !/^\s/.test(raw);
    if (isRule) {
      inGlobal = raw.trim() === "/*";
      continue;
    }
    if (!inGlobal) continue;
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    out.set(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim());
  }
  return out;
}

describe("public/_headers mirrors the Worker's security header set", () => {
  const parsed = parseGlobalBlock(readFileSync(HEADERS_FILE, "utf8"));

  it("parses a non-empty /* block", () => {
    // Parser control: every assertion below is all()-shaped over this map, and
    // all() over an empty map is vacuously true (ruling 89).
    expect(parsed.size).toBeGreaterThan(0);
  });

  it("carries every non-CSP header the Worker sends, with identical values", () => {
    for (const [name, value] of SECURITY_HEADERS) {
      expect(parsed.get(name), `${name} missing from or differing in public/_headers`).toBe(value);
    }
  });

  it("carries no header the Worker does not send", () => {
    const expected = new Set(SECURITY_HEADERS.map(([name]) => name));
    const orphans = [...parsed.keys()].filter((name) => !expected.has(name));
    expect(orphans, "public/_headers has entries SECURITY_HEADERS does not").toEqual([]);
  });
});
