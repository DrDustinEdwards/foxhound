import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";
import DemosPage from "~/routes/demos";

// J15 (job_c40fdf985a85), row M19: /demos. The spec is Recova's
// app/(marketing)/demos/page.tsx (blob 9a63a105), read whole. Recova is the
// spec for the layout (the shared page header, the 1200px column, the card
// grid, each card's name, blurb and full-width demo button, the centred line
// under the grid); the look is Capsomer's (RULES.md 1.1, Q12), teal, on the
// five text sizes (RULES.md 5.2). Copy is frozen in this job and not pinned
// here beyond the names the cards are found by.
//
// These read the RENDERED page, so a class on a helper that never reaches the
// page cannot pass.

function render(): string {
  const router = createMemoryRouter([{ path: "*", element: createElement(DemosPage) }], {
    initialEntries: ["/demos"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The page body under the shared header: Recova's 1200px column and everything in it. */
function column(html: string): string {
  const at = html.indexOf("max-w-[1200px]");
  expect(at, "the 1200px column is on the page").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<div", at));
}

/** Each demo link's opening tag through its close, in page order. */
function buttons(html: string): string[] {
  const out = [...column(html).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  expect(out.length, "the page renders its demo links").toBeGreaterThan(0);
  return out;
}

/** The opening tag of the element whose class list holds `cls`, for every match. */
function tagsWithClass(html: string, cls: string): string[] {
  return [...html.matchAll(/<[a-z]+ [^>]*class="([^"]*)"[^>]*>/g)]
    .filter((m) => m[1].split(/\s+/).includes(cls))
    .map((m) => m[0]);
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

const NAMES = ["Dashboard", "Recovery", "Disputes", "Intelligence"] as const;
const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Tailwind's text-* utilities that are colours or alignment, not sizes.
const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|brand-text|center|left|right)$/;

describe("/demos (J15, row M19)", () => {
  const html = render();

  it("keeps the four demo cards, each linking to its real entry route", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/demos"), "the matcher finds a known route").toBe(true);
    const links = buttons(html);
    expect(links.map((b) => NAMES.find((n) => b.includes(`View ${n} demo`)))).toEqual([...NAMES]);
    for (const b of links) {
      const href = /href="([^"]+)"/.exec(b)?.[1] ?? "";
      expect(paths.has(href), `${href} is a route`).toBe(true);
    }
  });

  it("sits in Capsomer's teal family with Foxhound's neutrals", () => {
    const open = column(html).slice(0, column(html).indexOf(">") + 1);
    expect(open).toContain("fh-cap");
    expect(open).toContain('data-family="teal"');
  });

  it("builds each card from Capsomer's panel, body only, with no Foxhound class on the panel", () => {
    const panels = tagsWithClass(column(html), "cap-panel");
    expect(panels).toHaveLength(4);
    for (const tag of panels) {
      const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
      expect(cls.split(/\s+/)).toEqual(["cap-panel"]);
    }
    expect(tagsWithClass(column(html), "cap-panel-body")).toHaveLength(4);
    expect(tagsWithClass(column(html), "cap-panel-head")).toHaveLength(0);
  });

  it("draws each demo link as Capsomer's primary button, with no Foxhound class on it", () => {
    for (const b of buttons(html)) {
      const tag = b.slice(0, b.indexOf(">") + 1);
      const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
      expect(cls.split(/\s+/)).toEqual(["cap-btn"]);
      expect(tag).toContain('data-variant="primary"');
      // The icon leads the label, as Recova's does, marked for the button's own icon spacing.
      expect(b).toMatch(/<svg[^>]*data-icon="start"[^>]*aria-hidden="true"/);
    }
  });

  it("keeps Recova's full-width button: each sits alone in a one-column grid wrapper", () => {
    for (const b of buttons(html)) {
      const before = column(html).slice(0, column(html).indexOf(b));
      const wrapper = before.slice(before.lastIndexOf("<div"));
      expect(wrapper, "the button's parent is a grid that stretches it").toMatch(/^<div class="[^"]*\bgrid\b/);
    }
  });

  it("draws no card or button from hand-rolled class strings", () => {
    const body = column(html);
    expect(body).not.toMatch(/rounded-\[12px\]/);
    expect(body).not.toMatch(/\bbg-brand\b/);
    expect(body).not.toMatch(/\bbg-surface\b/);
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
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  });

  it("takes Recova's sizes to the nearest of the five: the 1rem name to body, the 0.875rem blurb to label", () => {
    const body = column(html);
    for (const n of NAMES) {
      expect(body).toMatch(new RegExp(`<p class="[^"]*\\btext-body\\b[^"]*">${n}</p>`));
    }
    const blurbs = [...body.matchAll(/<p class="([^"]*)">[^<]{20,}<\/p>/g)].map((m) => m[1]);
    expect(blurbs.length).toBeGreaterThanOrEqual(4);
    for (const cls of blurbs) expect(cls.split(/\s+/)).toContain("text-label");
  });
});
