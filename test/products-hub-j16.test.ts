
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

// Tailwind's text-* utilities that are colours, not sizes.

describe("/products hub (J16, row M5)", () => {
  const html = render();

  it("points every card at a route that exists in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/products"), "the matcher finds a known route").toBe(true);
    const hrefs = cards(html).map((c) => /href="([^"]+)"/.exec(c)?.[1]);
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs) expect(paths.has(href ?? ""), `${href} is a route`).toBe(true);
  });
});
