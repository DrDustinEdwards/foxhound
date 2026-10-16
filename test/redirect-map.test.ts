import { describe, expect, it } from "vitest";

import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { deriveRecovaMap, deriveRecovaMapHosts, renderRecovaMapSource } from "~/lib/redirects/derive-recova-map";
import { RECOVA_CONFIG_REDIRECTS } from "~/lib/redirects/recova-config-redirects";
import { RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";
import routes from "~/routes";

import { LEGACY_MARKETING_ROUTES } from "./fixtures/legacy-marketing-routes";

interface RouteConfigEntry {
  path?: string;
  index?: boolean;
  children?: RouteConfigEntry[];
}

/** Every path app/routes.ts serves, dynamic segments kept as ":name". */
function foxhoundPaths(entries: RouteConfigEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      const segment = e.path.replace(/^\/+|\/+$/g, "");
      path = `${parent}/${segment}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) foxhoundPaths(e.children, path, out);
  }
  return out;
}

// The /docs/:slug pages Foxhound actually has, so a Recova guide maps only to
// a guide that exists and not to whatever the dynamic route would accept.
const SERVED = new Set([
  ...foxhoundPaths(routes as unknown as RouteConfigEntry[]),
  ...DOC_GUIDES.map((g) => `/docs/${g.slug}`),
]);

// The coverage assertions below are checked against
// test/fixtures/legacy-marketing-routes.ts, a snapshot of the legacy repo's
// actual `app/` tree (see that file's header for exactly what was walked
// and why), NOT a list re-typed here to match RECOVA_REDIRECT_MAP. A route
// present in the fixture but missing from the map, or a map entry the
// fixture doesn't recognize, fails the test either way, so this can
// actually catch a real gap (see git history: it once did, for
// /blog/sitemap.xml).

describe("RECOVA_REDIRECT_MAP", () => {
  // RULES.md 7.3: the map is regenerated, never hand-edited. The committed
  // file must be exactly what the derivation writes from Recova's routes and
  // Foxhound's routes.ts; `npm run gen:recova-map` rewrites it.
  it("is exactly the generated file (regenerate with `npm run gen:recova-map`)", async () => {
    expect(SERVED.has("/pricing")).toBe(true);
    await expect(renderRecovaMapSource(
        deriveRecovaMap(LEGACY_MARKETING_ROUTES, SERVED, RECOVA_CONFIG_REDIRECTS),
        deriveRecovaMapHosts(RECOVA_CONFIG_REDIRECTS),
      )).toMatchFileSnapshot(
      "../app/lib/redirects/recova-map.ts",
    );
  });

  it("sends every Recova path to a path Foxhound serves", () => {
    const shapes = new Set([...SERVED].map((p) => p.replace(/:[^/]+/g, ":")));
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(shapes.has(entry.to.replace(/:[^/]+/g, ":")), `${entry.from} -> ${entry.to}`).toBe(true);
    }
  });

  it("is same path, new domain for every Recova path Foxhound serves (ruling 408 binding 3)", () => {
    const named = RECOVA_REDIRECT_MAP.filter((e) => e.to !== e.from).map((e) => e.from);
    expect(named.sort()).toEqual(
      [
        "/disputes/demo",
        "/intelligence/demo",
        "/recovery/demo",
        // Recova's own next.config.ts redirects (J23), one hop to its destination.
        "/recovery/audit",
        "/recovery/audit/connect",
        "/recovery/audit/results",
        "/sitemap_index.xml",
        "/user-guides",
        "/user-guides/:path*",
      ].sort(),
    );
  });

  it("has a mapping entry for every legacy marketing route in the fixture", () => {
    const mappedFroms = new Set(RECOVA_REDIRECT_MAP.map((e) => e.from));
    for (const route of LEGACY_MARKETING_ROUTES) {
      expect(mappedFroms.has(route.url), `missing redirect mapping for ${route.url} (${route.sourceFile})`).toBe(
        true,
      );
    }
  });

  it("has no entries beyond the fixture's routes and Recova's config redirects (map and inputs stay in sync)", () => {
    const fixtureUrls = new Set([
      ...LEGACY_MARKETING_ROUTES.map((r) => r.url),
      ...RECOVA_CONFIG_REDIRECTS.filter((r) => !r.host).map((r) => r.source),
    ]);
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(fixtureUrls.has(entry.from), `${entry.from} is mapped but not in the legacy-routes fixture`).toBe(true);
    }
  });

  it("has no duplicate source paths", () => {
    const froms = RECOVA_REDIRECT_MAP.map((e) => e.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("the fixture itself has no duplicate URLs", () => {
    const urls = LEGACY_MARKETING_ROUTES.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("every target path is a real Foxhound path starting with /", () => {
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(entry.to.startsWith("/")).toBe(true);
    }
  });

  it("maps /product/* to itself, Foxhound's own path since J09 (ruling 55)", () => {
    const productEntries = RECOVA_REDIRECT_MAP.filter((e) => e.from.startsWith("/product/"));
    expect(productEntries.length).toBe(4);
    for (const entry of productEntries) {
      expect(entry.to).toBe(entry.from);
    }
  });

  it("maps /console to /console (J09)", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/console")?.to).toBe("/console");
  });

  it("maps /features and /blog/archive to themselves, which Foxhound serves", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/features")?.to).toBe("/features");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/archive")?.to).toBe("/blog/archive");
  });

  it("maps blog slugs and tag slugs verbatim", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/:slug")?.to).toBe("/blog/:slug");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/tag/:tag")?.to).toBe("/blog/tag/:tag");
  });

  it("self-maps the top-level SEO/utility file routes", () => {
    for (const path of ["/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt", "/feed.rss"]) {
      expect(RECOVA_REDIRECT_MAP.find((e) => e.from === path)?.to).toBe(path);
    }
  });

  it("maps Recova's blog feed and blog sitemap to themselves, now Foxhound serves both (J61, rows M15 and M16)", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/rss.xml")?.to).toBe("/blog/rss.xml");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/sitemap.xml")?.to).toBe("/blog/sitemap.xml");
  });
});
