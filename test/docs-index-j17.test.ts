import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";
import DocsIndexPage from "~/routes/docs/index";

// J17 (job_a6208d2d8478), row M17: the /docs index. The spec is Recova's
// app/(marketing)/docs/page.tsx (blob 4562a1ed) and
// components/MarketingPageHeader.tsx (blob 118a5104), read whole. This file
// pins the layout, the links and the look (Capsomer's parts, amber, the five
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

describe("/docs index (J17, row M17)", () => {
  const html = render();

  it("points every link at a route that exists in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/docs"), "the matcher finds a known route").toBe(true);
    for (const a of links(html)) {
      const to = href(a) ?? "";
      const known = paths.has(to) || (to.startsWith("/docs/") && paths.has("/docs/:slug"));
      expect(known, `${to} is a route`).toBe(true);
    }
  });
});
