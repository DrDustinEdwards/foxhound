import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HoundMark } from "~/components/hound-mark";
import { HOUND_MARK_PATH, HOUND_MARK_VIEWBOX } from "~/lib/brand/hound-mark";

// job_afa3591dac7e: Foxhound shows a PLACEHOLDER hound head, in teal, everywhere
// a logo mark appears, until Dustin picks the real logo (capsomer #65 item 15).
// One drawing (app/lib/brand/hound-mark.ts), every use drawn from it.

const read = (path: string) => readFileSync(path, "utf8");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("the mark has one source", () => {
  it("is marked a placeholder where it is drawn", () => {
    expect(read("app/lib/brand/hound-mark.ts")).toContain("PLACEHOLDER");
  });

  it("the favicon SVG is the same drawing, in the band's teal on the dark square", () => {
    const svg = read("public/favicon.svg");
    expect(svg).toContain(`viewBox="${HOUND_MARK_VIEWBOX}"`);
    expect(svg).toContain(`d="${HOUND_MARK_PATH}"`);
    expect(svg).toContain('fill="#249398"');
    expect(svg).toContain('fill="#111210"');
    expect(svg).toContain("PLACEHOLDER");
    // The old mark was an amber monospace x.
    expect(svg).not.toContain("<text");
    expect(svg.toLowerCase()).not.toContain("#f0b429");
  });

  it("the inline mark draws the same path in currentColor", () => {
    const html = renderToStaticMarkup(createElement(HoundMark, { className: "cap-admin-logo" }));
    expect(html).toContain(`viewBox="${HOUND_MARK_VIEWBOX}"`);
    expect(html).toContain(`d="${HOUND_MARK_PATH}"`);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('class="cap-admin-logo"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("the favicon set", () => {
  it("the PNG favicon is 32 and the apple touch icon 180", () => {
    expect(pngSize("public/favicon.png")).toEqual({ width: 32, height: 32 });
    expect(pngSize("public/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("the build script asserts teal, not amber", () => {
    const script = read("scripts/build-icons.mjs");
    expect(script).toContain("../app/lib/brand/hound-mark.ts");
    expect(script).toContain("0x24, 0x93, 0x98");
    expect(script).not.toContain("amber");
  });
});

describe("every use points at the mark", () => {
  it("the admin strip shows the hound for Foxhound", () => {
    const admin = read("app/layouts/admin-shell.tsx");
    expect(admin).toContain('<HoundMark className="cap-admin-logo" />');
    expect(admin).toContain("apps={STRIP_APPS}");
  });

  it("the route splash draws the SVG, which stays sharp at 96", () => {
    expect(read("app/components/route-splash.tsx")).toContain('src="/favicon.svg"');
  });

  it("the RSS channel image is the 180 icon, not the 32 favicon", () => {
    expect(read("app/routes/files/feed.ts")).toContain("<url>${url}/apple-touch-icon.png</url>");
  });
});
