import { describe, expect, it } from "vitest";

import { scanContent } from "../scripts/check-tokens-lib.mjs";

// Written as .mjs, unlike every other test here, on purpose: tsconfig sets
// allowJs false and includes only ts/tsx, so a .ts test cannot import the
// .mjs guard without adding a declaration file for it. Vitest picks this up
// from its default include; tsc ignores it, exactly as it ignores scripts/.
//
// The guard exists to catch raw hex colors and px font sizes. Per
// capsid/conventions.md, a guard that has never been observed failing has not
// been verified, so this asserts in BOTH directions: planted violations must
// be caught, and planted look-alikes must NOT be.

const TSX = "app/components/example.tsx";
const CSS = "app/components/example.css";

describe("hex matcher: numeric HTML entities are not hex colors", () => {
  // The defect this test was written for. legacy ProductSections renders its
  // pricing checkmark as a numeric entity; the matcher read its digits as the
  // hex color "#10003" and blocked the write.
  it("does not flag a numeric HTML entity in markup", () => {
    expect(scanContent(TSX, "<span>&#10003;</span>")).toEqual([]);
  });

  it("does not flag a numeric HTML entity quoted inside a comment", () => {
    // The second firing: a comment explaining the first failure tripped it.
    expect(scanContent(TSX, "// legacy writes this as &#10003; in its markup")).toEqual([]);
  });

  it("does not flag several entities in one file", () => {
    expect(scanContent(TSX, "<p>&#10003; then &#9733; then &#8364;</p>")).toEqual([]);
  });

  it("does not flag a short entity whose digits look like a 3-digit hex", () => {
    // &#123; is "{". Its digits are a perfectly plausible hex color, which is
    // why a digit-count restriction alone would not fix this.
    expect(scanContent(TSX, "<code>&#123;</code>")).toEqual([]);
  });
});

describe("hex matcher: real hex colors are still caught", () => {
  it("flags a 6-digit hex", () => {
    expect(scanContent(TSX, 'const c = "#f0b429";')).toHaveLength(1);
  });

  it("flags a 3-digit hex", () => {
    expect(scanContent(TSX, "color: #fff;")).toHaveLength(1);
  });

  it("flags an 8-digit hex", () => {
    expect(scanContent(CSS, "color: #f0b429ff;")).toHaveLength(1);
  });

  it("flags a bare hash-plus-digits NOT written as an entity", () => {
    // The decisive pair with the entity cases above: identical digits, no
    // leading ampersand and no trailing semicolon, so it is still a raw hex
    // token and must still be reported. This is what stops the fix from
    // becoming a blanket exemption for those digits.
    expect(scanContent(TSX, "const c = #10003;")).toHaveLength(1);
  });

  it("still flags a hex sitting immediately after other punctuation", () => {
    expect(scanContent(CSS, "a:hover{color:#abc}")).toHaveLength(1);
  });
});

describe("hex matcher: exemptions still hold", () => {
  it("allows raw hex in the token file", () => {
    expect(scanContent("app/app.css", "--brand: #249398;")).toEqual([]);
  });

  it("allows raw hex under the email directory", () => {
    expect(scanContent("app/lib/email/template.ts", 'const bg = "#111210";')).toEqual([]);
  });
});

describe("px font-size matchers are unchanged", () => {
  it("flags a Tailwind arbitrary px size", () => {
    expect(scanContent(TSX, '<p className="text-[13px]">x</p>')).toHaveLength(1);
  });

  it("flags a raw css px font-size", () => {
    expect(scanContent(CSS, "font-size: 13px;")).toHaveLength(1);
  });

  it("flags an inline style px font size", () => {
    expect(scanContent(TSX, 'style={{ fontSize: "13px" }}')).toHaveLength(1);
  });

  it("does not flag rem sizes", () => {
    expect(scanContent(TSX, '<p className="text-[0.9375rem]">x</p>')).toEqual([]);
  });

  it("allows px font sizes on the og image route", () => {
    expect(scanContent("app/routes/files/og.ts", 'fontSize: "13px"')).toEqual([]);
  });
});

describe("px font sizes wrapped in a function are caught too", () => {
  // The blind spot this block was written for, found on M22's /audit hero.
  // The original matcher required text-[Npx] literally, so px inside clamp()
  // slipped straight past it: legacy's text-[clamp(28px,5vw,44px)] would have
  // shipped a hero frozen against the reader's font-size setting, and the
  // guard would have stayed green. Measured before widening: zero existing
  // non-exempt carriers, so this closes a hole rather than papering one over.
  it("flags px inside a Tailwind clamp()", () => {
    expect(scanContent(TSX, '<h1 className="text-[clamp(28px,5vw,44px)]">x</h1>')).toHaveLength(1);
  });

  it("flags px inside a raw css clamp()", () => {
    expect(scanContent(CSS, "font-size: clamp(28px, 5vw, 44px);")).toHaveLength(1);
  });

  it("flags px inside min() and max()", () => {
    expect(scanContent(TSX, '<p className="text-[min(14px,2vw)]">x</p>')).toHaveLength(1);
    expect(scanContent(TSX, '<p className="text-[max(14px,2vw)]">x</p>')).toHaveLength(1);
  });

  it("flags px inside calc()", () => {
    expect(scanContent(CSS, "font-size: calc(1rem + 2px);")).toHaveLength(1);
  });

  // The decisive negative pair: the SAME clamp shape in rem must stay silent,
  // or the widened matcher would flag the very fix it exists to encourage.
  it("does not flag an all-rem clamp", () => {
    expect(scanContent(TSX, '<h1 className="text-[clamp(1.75rem,5vw,2.75rem)]">x</h1>')).toEqual([]);
    expect(scanContent(CSS, "font-size: clamp(1.75rem, 5vw, 2.75rem);")).toEqual([]);
  });

  it("does not flag a px length that is not a font size", () => {
    // Only font sizes are governed. Spacing, borders and offsets in px are
    // fine, and a matcher that swept those in would be wrong in the other
    // direction.
    expect(scanContent(TSX, '<div className="mt-[7px] w-[680px]" />')).toEqual([]);
    expect(scanContent(CSS, "padding: 10px; border-radius: 12px;")).toEqual([]);
  });

  it("still exempts function-wrapped px on the og image route", () => {
    expect(scanContent("app/routes/files/og.ts", "font-size: clamp(28px, 5vw, 44px);")).toEqual([]);
  });
});
