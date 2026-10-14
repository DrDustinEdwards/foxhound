import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";
import ProductsIndexPage from "~/routes/products/index";

// J16 (job_3ea21f4c3086), row M5: the /products hub. The spec is Recova's
// app/(marketing)/products/page.tsx (blob 1349c46e) and lib/products.ts
// (blob 6be24574), read whole. This file pins the layout, the links and the
// look (Capsomer's parts, teal, the five text sizes); the copy is pinned in
// products-hub-j16-copy.test.ts.
//
// These read the RENDERED page below the shared marketing page header (row
// M29), so a class on a helper that never reaches a reader cannot pass.

function render(): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(ProductsIndexPage) }], {
    initialEntries: ["/products"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The hub column: Recova's 720px wrapper and everything inside it. */
function hub(html: string): string {
  const col = html.indexOf("max-w-[720px]");
  expect(col, "the 720px hub column is on the page").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<div", col));
}

/** Each card's opening tag through its close, in page order. */
function cards(html: string): string[] {
  const out = [...hub(html).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  expect(out.length, "the hub renders its cards").toBeGreaterThan(0);
  return out;
}

const NAMES = ["Audit", "Recovery", "Disputes", "Intelligence"] as const;

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

describe("/products hub (J16, row M5)", () => {
  const html = render();

  it("renders Recova's four cards in Recova's order", () => {
    const names = cards(html).map((c) => NAMES.find((n) => c.includes(`>${n}<`)));
    expect(names).toEqual([...NAMES]);
  });

  it("points every card at a route that exists in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/products"), "the matcher finds a known route").toBe(true);
    const hrefs = cards(html).map((c) => /href="([^"]+)"/.exec(c)?.[1]);
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs) expect(paths.has(href ?? ""), `${href} is a route`).toBe(true);
  });

  it("builds each card from Capsomer's panel, in the teal family with Foxhound's neutrals", () => {
    const body = hub(html);
    const open = body.slice(0, body.indexOf(">") + 1);
    expect(open).toContain("fh-cap");
    expect(open).toContain('data-family="teal"');
    for (const c of cards(html)) {
      const tag = c.slice(0, c.indexOf(">") + 1);
      expect(tag).toMatch(/class="cap-panel[" ]/);
      expect(c).toContain('class="cap-panel-body"');
    }
  });

  it("puts no Foxhound-only class on the Capsomer panel itself", () => {
    for (const c of cards(html)) {
      const cls = /class="([^"]*)"/.exec(c.slice(0, c.indexOf(">") + 1))?.[1] ?? "";
      // "group" is Tailwind's marker for the arrow's hover nudge; it carries no style.
      expect(cls.split(/\s+/).filter((x) => x !== "cap-panel" && x !== "group")).toEqual([]);
    }
  });

  it("carries no amber anywhere on the page", () => {
    expect(html).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes, never an arbitrary text-[ value", () => {
    const body = hub(html);
    expect(body).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of body.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  });

  it("draws the icon, price and Learn more in Capsomer's accent text", () => {
    for (const c of cards(html)) {
      expect((c.match(/text-accent-text/g) ?? []).length).toBe(3);
    }
  });
});
