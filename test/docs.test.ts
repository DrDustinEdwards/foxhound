import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget } from "~/components/docs/doc-widgets";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import { DOCS_FIRST_PUBLISHED, DOC_GUIDES } from "~/lib/marketing/docs-content";
import { classifyDecline } from "~/lib/recovery/decline";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { docsItemListJsonLd, techArticleJsonLd } from "~/lib/seo/jsonld";
import routes from "~/routes";
import DocsIndexPage from "~/routes/docs/index";

function render(): string {
  const page = createElement(DocsIndexPage);
  const router = createMemoryRouter([{ path: "*", element: page }], { initialEntries: ["/docs"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The docs column (fh-mk-article) and everything inside it. */
function column(html: string): string {
  const col = html.indexOf("fh-mk-article");
  expect(col, "the docs column is on the page").toBeGreaterThan(-1);
  const body = html.slice(html.lastIndexOf("<div", col));
  return body;
}

/** Every link in the column, opening tag through close, in page order. */
function links(html: string): string[] {
  return [...column(html).matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
}

const href = (a: string) => /href="([^"]+)"/.exec(a)?.[1];

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

describe("/docs index", () => {
  const html = render();

  it("points every link at a route that exists in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/docs"), "the matcher finds a known route").toBe(true);
    for (const a of links(html)) {
      const to = href(a) ?? "";
      if (to.startsWith("mailto:")) continue; // the support address, not a route
      const known = paths.has(to) || (to.startsWith("/docs/") && paths.has("/docs/:slug"));
      expect(known, `${to} is a route`).toBe(true);
    }
  });
});

function renderWidget(name: Parameters<typeof DocWidget>[0]["name"]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocWidget, { name })),
  );
}

// The widgets read the engine's own constants, so a picture cannot drift from the code.
describe("docs widgets", () => {
  it("every decline code the guide names classifies into the category it is shown under", () => {
    const html = renderWidget("decline-categories");
    for (const [category, label] of Object.entries(DECLINE_CATEGORY_LABELS)) {
      const start = html.indexOf(`data-category="${category}"`);
      expect(start, `${label} card`).toBeGreaterThanOrEqual(0);
      const end = html.indexOf("data-category=", start + 1);
      const card = html.slice(start, end === -1 ? undefined : end);
      const codes = [...card.matchAll(/<code[^>]*>([a-z_]+)<\/code>/g)].map((m) => m[1]!);
      if (category !== "unknown")
        expect(codes.length, `${category} names codes`).toBeGreaterThan(0);
      for (const code of codes) expect(classifyDecline(code), code).toBe(category);
    }
  });

  it("health bands show Foxhound's cutoffs", () => {
    const html = renderWidget("health-bands");
    expect(html).toContain(`Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`);
    expect(html).toContain(`${WATCH_CEILING} and above`);
  });
});

const URL_BASE = "https://foxhoundapp.test";

// Derived from DOC_GUIDES, so a sixth guide is covered the day it is added.
describe("docs JSON-LD", () => {
  it("every guide emits a TechArticle built from its own fields", () => {
    for (const guide of DOC_GUIDES) {
      const block = techArticleJsonLd(URL_BASE, {
        headline: guide.heading,
        description: guide.description,
        path: `/docs/${guide.slug}`,
        datePublished: guide.datePublished,
      });
      expect(block["@type"]).toBe("TechArticle");
      expect(block.headline, `${guide.slug} headline`).toBe(guide.heading);
      expect(block.description).toBe(guide.description);
      expect(block.url).toBe(`${URL_BASE}/docs/${guide.slug}`);
      expect(block.datePublished).toBe(DOCS_FIRST_PUBLISHED);
      expect(block.publisher).toEqual({ "@id": `${URL_BASE}/#organization` });
    }
  });

  it("the docs index emits an ItemList carrying every guide, in render order", () => {
    const list = docsItemListJsonLd(URL_BASE, DOC_GUIDES);
    const items = list.itemListElement as { name: string; position: number; url: string }[];
    expect(list["@type"]).toBe("ItemList");
    expect(items.map((i) => i.name)).toEqual(DOC_GUIDES.map((g) => g.title));
    expect(items.map((i) => i.position)).toEqual(DOC_GUIDES.map((_, i) => i + 1));
    for (const item of items) expect(item.url.startsWith(`${URL_BASE}/docs/`)).toBe(true);
  });
});
