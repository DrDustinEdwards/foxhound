import { readFileSync } from "node:fs";

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import PrivacyPage from "~/routes/privacy";
import TermsPage from "~/routes/terms";

// J51 (job_615a012e7035), rows M20 and M21: both legal pages on Recova's chrome,
// built from Capsomer's parts, teal and on the five text sizes. The spec is
// Recova's app/(marketing)/privacy/page.tsx (blob 8f8dfb8e) and
// app/(marketing)/terms/page.tsx (blob 88005fad), read whole. Copy is not
// pinned here: it waits for Dustin.
//
// These read the RENDERED page, below the shared marketing page header (which
// is its own row, M29), so a class on a helper that never reaches a reader
// cannot pass for one that does.

function render(page: ComponentType, path: string): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(page) }], {
    initialEntries: [path],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The legal body: Recova's 720px column, everything after the shared page header. */
function body(html: string): string {
  const i = html.lastIndexOf("<div", html.indexOf("max-w-[720px]"));
  expect(i, "the 720px legal column is on the page").toBeGreaterThan(-1);
  return html.slice(i);
}

function at(html: string, marker: string): number {
  const i = html.indexOf(marker);
  expect(i, `${marker} is on the page`).toBeGreaterThan(-1);
  return i;
}

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Tailwind's text-* utilities that are colours or alignment, not sizes.
const NOT_A_SIZE = /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|left|right|center)$/;

function sizeClasses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      const base = c.replace(/^[a-z0-9-]+:/g, "");
      if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) out.push(base);
    }
  }
  return out;
}

const PAGES = [
  { name: "privacy", page: PrivacyPage, path: "/privacy", sections: 15 },
  { name: "terms", page: TermsPage, path: "/terms", sections: 26 },
] as const;

describe.each(PAGES)("/$name: Recova's chrome on Capsomer's parts", ({ page, path, sections }) => {
  const html = render(page, path);
  const legal = body(html);

  it("sits in Capsomer's teal family with Foxhound's neutrals, at Recova's 720px width", () => {
    const open = legal.slice(0, legal.indexOf(">") + 1);
    expect(open).toContain("fh-cap");
    expect(open).toContain('data-family="teal"');
    expect(open).toContain("max-w-[720px]");
  });

  it("carries no amber anywhere on the page", () => {
    expect(html).not.toMatch(/amber/);
  });

  it("draws every link in Capsomer's accent text, and points the focus ring at the family's teal", () => {
    expect(legal.slice(0, legal.indexOf(">") + 1)).toContain("[--border-focus:var(--ring)]");
    const links = [...legal.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(sections);
    for (const a of links) {
      expect(a).toContain("text-accent-text");
      expect(a).toContain("hover:text-accent-hover");
      expect(a).toContain("underline-offset-2");
    }
  });

  it("uses only the five text sizes, and no arbitrary text-[X] value", () => {
    const sizes = sizeClasses(legal);
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
    expect(legal).not.toMatch(/text-\[/);
  });

  it(`has ${sections} numbered sections, each reached from the contents list`, () => {
    const ids = [...legal.matchAll(/<h2 id="([^"]+)"[^>]*>(\d+)\. /g)].map((m) => m[1]);
    expect(ids).toHaveLength(sections);
    const hrefs = [...legal.matchAll(/<li[^>]*><a href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(ids);
  });

  it("names no entity that does not exist and carries no Recova branding", () => {
    expect(html).not.toMatch(/Recova|Foxing|LLC/);
  });
});

describe("/privacy: Recova's arrangement", () => {
  const html = render(PrivacyPage, "/privacy");
  const legal = body(html);

  it("runs intro, summary, table of contents, rule, then the sections, in Recova's order", () => {
    const order = [
      "This notice describes how Foxhound",
      'class="cap-panel',
      ">Table of Contents</h2>",
      "<hr",
      'id="collect"',
    ].map((m) => at(legal, m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("builds the summary from Capsomer's panel, headed 'Summary of key points'", () => {
    expect(legal).toMatch(/<section class="cap-panel[^"]*"[^>]*><header class="cap-panel-head"><h2>Summary of key points<\/h2>/);
  });

  it("sets each summary lead-in at medium weight, as Recova does", () => {
    const strongs = [...legal.matchAll(/<strong([^>]*)>/g)].map((m) => m[1]);
    expect(strongs.length).toBeGreaterThan(0);
    for (const s of strongs) expect(s).toContain("font-medium");
  });

  it("points the summary at the contents list where it now is, below it", () => {
    const summary = legal.slice(at(legal, 'class="cap-panel'), at(legal, ">Table of Contents</h2>"));
    expect(summary).not.toMatch(/contents list\s+above/);
    expect(summary).toMatch(/below/);
  });
});

describe("/terms: Recova's arrangement", () => {
  const legal = body(render(TermsPage, "/terms"));

  it("runs contents, rule, the unnumbered agreement, then the sections", () => {
    const order = [">Contents</h2>", "<hr", ">AGREEMENT TO OUR LEGAL TERMS</h2>", 'id="services"'].map((m) =>
      at(legal, m),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("names Dustin Edwards, sole proprietor, Texas, as the operator", () => {
    expect(legal).toContain("operated by Dustin Edwards, a sole proprietor based in Texas, United States");
  });
});

describe("one chrome kit, as Recova's two pages share one", () => {
  const strip = (p: string) =>
    readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("both routes take their helpers from the shared legal kit and define none of their own", () => {
    for (const route of ["app/routes/privacy.tsx", "app/routes/terms.tsx"]) {
      const src = strip(route);
      expect(src).toContain('from "~/components/legal-page"');
      expect(src).not.toMatch(/function (Section|P|H3)\(/);
    }
  });

  it("loads Capsomer's panel stylesheet with the kit", () => {
    expect(strip("app/components/legal-page.tsx")).toContain('import "capsomer/panel.css"');
  });
});
