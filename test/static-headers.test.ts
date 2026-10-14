import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EMBEDDABLE_STATIC_PATHS,
  renderStaticHeadersFile,
  SECURITY_HEADERS,
} from "~/lib/http/header-set";

// public/_headers carries the security header set for static-asset responses,
// which the Worker never sees (RULES.md 4.2: run_worker_first stays off). A
// static file cannot import a constant, so the file is GENERATED from the same
// set the Worker applies (scripts/gen-headers.mjs, `npm run gen:headers`), and
// this test fails if the committed file is not exactly what the generator writes.
// conventions.md's rule for a necessary duplicate also applies: the parsed block
// is compared with the source of truth in BOTH directions, so neither a missing
// entry nor an orphaned one can survive a hand edit.
//
// Content-Security-Policy is excluded on purpose: it carries a per-request nonce
// and cannot be static (ruling 93 keeps that strength as class 2(a)). If a future
// edit adds a static CSP line to _headers, the orphan check below fails, which is
// the intended outcome.

const HEADERS_FILE = new URL("../public/_headers", import.meta.url);

/** The names a block detaches with Cloudflare's `! Name` syntax. */
function detachedIn(text: string, rule: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      inBlock = raw.trim() === rule;
      continue;
    }
    if (inBlock && raw.trim().startsWith("!")) out.push(raw.trim().slice(1).trim());
  }
  return out;
}

/** Parse one block of a Cloudflare _headers file into name/value pairs. */
function parseBlock(text: string, rule: string): Map<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const isRule = !/^\s/.test(raw);
    if (isRule) {
      inBlock = raw.trim() === rule;
      continue;
    }
    if (!inBlock) continue;
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    out.set(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim());
  }
  return out;
}

describe("public/_headers is generated from the Worker's security header set", () => {
  const text = readFileSync(HEADERS_FILE, "utf8");
  const parsed = parseBlock(text, "/*");

  it("is byte-identical to what scripts/gen-headers.mjs writes (run `npm run gen:headers`)", () => {
    expect(text).toBe(renderStaticHeadersFile());
  });

  it("parses a non-empty /* block", () => {
    // Parser control: every assertion below is all()-shaped over this map, and
    // all() over an empty map is vacuously true (ruling 89).
    expect(parsed.size).toBeGreaterThan(0);
  });

  it("carries every non-CSP header the Worker sends, with identical values", () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(parsed.get(name), `${name} missing from or differing in public/_headers`).toBe(value);
    }
  });

  it("carries no header the Worker does not send", () => {
    const orphans = [...parsed.keys()].filter((name) => !(name in SECURITY_HEADERS));
    expect(orphans, "public/_headers has entries SECURITY_HEADERS does not").toEqual([]);
  });

  // F5 / ruling 99: /favicon.png is the RSS channel image, which feed readers
  // and other sites load cross-origin, and Recova sent no CORP at all. The /*
  // block's same-origin would block that, and Cloudflare JOINS a header two
  // rules set ("same-origin, cross-origin", which browsers read as invalid), so
  // each embeddable path detaches the inherited value and sets cross-origin.
  it("lets the feed's channel image and the favicon be embedded cross-origin", () => {
    expect([...EMBEDDABLE_STATIC_PATHS].sort()).toEqual(["/favicon.png", "/favicon.svg"]);
    for (const path of EMBEDDABLE_STATIC_PATHS) {
      expect(detachedIn(text, path), path).toEqual(["Cross-Origin-Resource-Policy"]);
      expect(parseBlock(text, path).get("Cross-Origin-Resource-Policy"), path).toBe("cross-origin");
    }
  });

  it("keeps the immutable cache rule on hashed assets", () => {
    expect(parseBlock(text, "/assets/*").get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });
});
