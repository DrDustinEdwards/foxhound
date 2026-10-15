import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";
import DocsIndexPage from "~/routes/docs/index";

// J17 (job_a6208d2d8478), row M17: the /docs index. The spec is Recova's
// app/(marketing)/docs/page.tsx (blob 4562a1ed) and
// components/MarketingPageHeader.tsx (blob 118a5104), read whole. This file
// pins the layout, the links and the look (Capsomer's parts, teal, the five
// text sizes). The copy is 20d-frozen and not touched by this job.
//
// These read the RENDERED page below the shared marketing page header (row
// M29), so a class on a helper that never reaches a reader cannot pass.

function render(): string {
  const page = createElement(DocsIndexPage, {
    loaderData: { siteUrl: "https://example.com" },
  } as unknown as Parameters<typeof DocsIndexPage>[0]);
  const router = createMemoryRouter([{ path: "*", element: page }], { initialEntries: ["/docs"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The docs column: Recova's 720px wrapper and everything inside it. */
function column(html: string): string {
  const col = html.indexOf("max-w-[720px]");
  expect(col, "the 720px docs column is on the page").toBeGreaterThan(-1);
  const body = html.slice(html.lastIndexOf("<div", col));
  return body.slice(0, body.indexOf("<script"));
}

/** Every link in the column, opening tag through close, in page order. */
function links(html: string): string[] {
  return [...column(html).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
}

const href = (a: string) => /href="([^"]+)"/.exec(a)?.[1];
const openTag = (a: string) => a.slice(0, a.indexOf(">") + 1);
const classOf = (a: string) => /class="([^"]*)"/.exec(openTag(a))?.[1] ?? "";

/** The five guide cards: the links that point into /docs/. */
function cards(html: string): string[] {
  const out = links(html).filter((a) => href(a)?.startsWith("/docs/"));
  expect(out.length, "the column renders its guide cards").toBeGreaterThan(0);
  return out;
}

/** The cross-links under the cards: every column link not into /docs/. */
function crossLinks(html: string): string[] {
  return links(html).filter((a) => !href(a)?.startsWith("/docs/"));
}

interface RouteEntry {
  path?: string;
  index?: boolean;
  children?: RouteEntry[];
}

function routePaths(entries: RouteEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      path = `${parent}/${e.path.replace(/^\/+|\/+$/g, "")}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) routePaths(e.children, path, out);
  }
  return out;
}

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Tailwind's text-* utilities that are colours, not sizes.
const NOT_A_SIZE = /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|brand-text)$/;

describe("/docs index (J17, row M17)", () => {
  const html = render();

  it("renders Platform first, then Recova's four product guides in Recova's order", () => {
    expect(cards(html).map(href)).toEqual([
      "/docs/platform",
      "/docs/audit",
      "/docs/recovery",
      "/docs/disputes",
      "/docs/intelligence",
    ]);
  });

  it("keeps Recova's arrangement: Platform full width above a two-column grid of four", () => {
    const body = column(html);
    const grid = body.indexOf('class="grid grid-cols-1 gap-4 sm:grid-cols-2"');
    expect(grid, "the product grid is on the page").toBeGreaterThan(-1);
    expect(body.indexOf('href="/docs/platform"')).toBeLessThan(grid);
    const inGrid = [...body.slice(grid).matchAll(/href="(\/docs\/[^"]+)"/g)].map((m) => m[1]);
    expect(inGrid).toEqual(["/docs/audit", "/docs/recovery", "/docs/disputes", "/docs/intelligence"]);
  });

  it("closes with Recova's two cross-links, features then pricing", () => {
    expect(crossLinks(html).map(href)).toEqual(["/features", "/pricing"]);
  });

  it("points every link at a route that exists in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/docs"), "the matcher finds a known route").toBe(true);
    for (const a of links(html)) {
      const to = href(a) ?? "";
      const known = paths.has(to) || (to.startsWith("/docs/") && paths.has("/docs/:slug"));
      expect(known, `${to} is a route`).toBe(true);
    }
  });

  it("builds each guide card from Capsomer's panel, in the teal family with Foxhound's neutrals", () => {
    const body = column(html);
    const open = body.slice(0, body.indexOf(">") + 1);
    expect(open).toContain("fh-cap");
    expect(open).toContain('data-family="teal"');
    for (const c of cards(html)) {
      expect(openTag(c)).toMatch(/class="cap-panel[" ]/);
      expect(c).toContain('class="cap-panel-body"');
    }
  });

  it("puts no Foxhound-only class on the Capsomer panel itself", () => {
    for (const c of cards(html)) {
      // "group" is Tailwind's marker for the arrow's hover nudge; it carries no style.
      expect(classOf(c).split(/\s+/).filter((x) => x !== "cap-panel" && x !== "group")).toEqual([]);
    }
  });

  it("carries no amber anywhere on the page", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const body = column(html);
    expect(body).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of body.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^(?:[a-z0-9-]+:)+/, "");
        if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  });

  it("draws Read guide and both cross-links in Capsomer's accent text, never the old brand text", () => {
    for (const c of cards(html)) expect((c.match(/text-accent-text/g) ?? []).length).toBe(1);
    for (const a of crossLinks(html)) expect(classOf(a).split(/\s+/)).toContain("text-accent-text");
    expect(column(html)).not.toMatch(/brand-text|border-brand/);
  });

  it("gives each cross-link a 24px line box (WCAG 2.2 target size)", () => {
    for (const a of crossLinks(html)) expect(classOf(a).split(/\s+/)).toContain("leading-6");
  });
});
