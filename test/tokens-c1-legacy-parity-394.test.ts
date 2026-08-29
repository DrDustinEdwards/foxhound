import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// 394 cross-cutting finding C1. The walk measured the same three divergences on
// all eight paired app surfaces in dark, which makes them one token fix rather
// than eight per-surface fixes (119's shared-member shape).
//
// The legacy values below are read from legacy app/globals.css, blob
// `f03f8a59`, its `:root, :root[data-theme='dark']` block.
//
// WHY THIS IS ASSERTED ON THE TOKEN AND NOT ON A RENDER: verification-gotchas
// records that --surface and --chrome were BOTH #1a1c18 in dark, so a panel on
// either one renders identically until light mode. A dark-mode visual check
// cannot falsify this class of change. The collapse is exactly what C1 found:
// Foxhound's --surface had taken --chrome's value, and its --text had taken
// --chrome-text's, so two token families had folded into one.

const CSS = readFileSync(new URL("../app/app.css", import.meta.url), "utf8");

/** The declarations inside one top-level rule, by its exact selector text. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = CSS.indexOf("{", start);
  // The token blocks contain no nested braces, so the first close is the end.
  const close = CSS.indexOf("\n}", open);
  const body = CSS.slice(open + 1, close);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const dark = block(':root,\n:root[data-theme="dark"]');
const light = block(':root[data-theme="light"]');

/** #rrggbb to the rgb() form the walk's computed-style read reported. */
function rgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex: ${hex}`);
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

describe("C1: the three dark tokens carry legacy's values", () => {
  it("--surface is legacy's #181917, the card background", () => {
    expect(dark.get("--surface")).toBe("#181917");
    expect(rgb(dark.get("--surface")!)).toBe("rgb(24, 25, 23)");
  });

  it("--border is legacy's #2a2b28, the card border", () => {
    expect(dark.get("--border")).toBe("#2a2b28");
    expect(rgb(dark.get("--border")!)).toBe("rgb(42, 43, 40)");
  });

  it("--text is legacy's #e5e8e2, the body text", () => {
    expect(dark.get("--text")).toBe("#e5e8e2");
    expect(rgb(dark.get("--text")!)).toBe("rgb(229, 232, 226)");
  });
});

describe("C1: the collapsed pairs are separated again", () => {
  // These are the assertions a blind find-and-replace would fail. The drifted
  // values were not arbitrary, they were the CHROME family's values, and
  // legacy's chrome tokens keep them.
  it("--surface is no longer --chrome's value", () => {
    expect(dark.get("--chrome")).toBe("#1a1c18");
    expect(dark.get("--surface")).not.toBe(dark.get("--chrome"));
  });

  it("--text is no longer --chrome-text's value", () => {
    expect(dark.get("--chrome-text")).toBe("#f0ede8");
    expect(dark.get("--text")).not.toBe(dark.get("--chrome-text"));
  });
});

describe("C1: light mode is untouched", () => {
  // The fix is scoped to the dark block. Legacy's light --surface is #ffffff,
  // which Foxhound already matched, so a change here would be a regression
  // introduced by this fold rather than a parity fix.
  it("keeps the light values it had", () => {
    expect(light.get("--surface")).toBe("#ffffff");
    expect(light.get("--border")).toBe("#cccbc3");
    expect(light.get("--text")).toBe("#14150f");
  });

  it("does not import a dark value into light", () => {
    expect(light.get("--surface")).not.toBe(dark.get("--surface"));
    expect(light.get("--text")).not.toBe(dark.get("--text"));
  });
});
