import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { DocWidget } from "~/components/docs/doc-widgets";
import { classifyDecline } from "~/lib/recovery/decline";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
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
});
