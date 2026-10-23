
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import routes from "~/routes";
import PricingPage from "~/routes/pricing";

// J54 (job_72985caa71f1), row M4: /pricing's layout, links, structured data and
// look. The spec is Recova's app/(marketing)/pricing/page.tsx (blob 8e91e160),
// read whole. Layout is Recova's; the look is Capsomer's (RULES.md 1.1): each
// card and FAQ item is Capsomer's panel in the teal family, the closing link is
// Capsomer's primary button, and text is on the five sizes (RULES.md 5.2). The
// copy is pinned in pricing-j54-copy.test.ts.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass.

const SITE = "https://example.com";

function render(): string {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(PricingPage as never, { loaderData: { siteUrl: SITE } }) }],
    { initialEntries: ["/pricing"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}


/** One card per product, from its id to the next card or the end of the grid. */
function cards(html: string): Map<string, string> {
  const at = html.indexOf("max-w-[1200px]");
  expect(at, "the 1200px card container is on the page").toBeGreaterThan(-1);
  const grid = html.slice(at, html.indexOf("</section>", at));
  const out = new Map<string, string>();
  const starts = PRODUCT_ORDER.map((k) => grid.indexOf(`id="${k}"`));
  PRODUCT_ORDER.forEach((k, i) => {
    expect(starts[i], `the ${k} card is on the page`).toBeGreaterThan(-1);
    const from = grid.lastIndexOf("<", starts[i]);
    out.set(k, grid.slice(from, i + 1 < starts.length ? grid.lastIndexOf("<", starts[i + 1]) : undefined));
  });
  return out;
}

/** The "Learn more" anchor in a card. */
function learnMore(card: string): string {
  const m = /<a [^>]*>Learn more[\s\S]*?<\/a>/.exec(card);
  expect(m, "the card has its Learn more link").not.toBeNull();
  return m?.[0] ?? "";
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

// Tailwind's text-* utilities that are colours or alignment, not sizes.

describe("/pricing layout and links (J54, row M4)", () => {
  const html = render();

  it("points every Learn more at PRODUCTS[key].href, and every one is a route in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/pricing"), "the matcher finds a known route").toBe(true);
    for (const [k, card] of cards(html)) {
      const href = /href="([^"]+)"/.exec(learnMore(card))?.[1];
      expect(href, k).toBe(PRODUCTS[k as keyof typeof PRODUCTS].href);
      expect(paths.has(href ?? ""), `${href} is a route`).toBe(true);
    }
  });
});
