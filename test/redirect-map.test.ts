import { describe, expect, it } from "vitest";

import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { RECOVA_CONFIG_REDIRECTS } from "~/lib/redirects/recova-config-redirects";
import { deriveRecovaMap } from "~/lib/redirects/derive-recova-map";
import { RECOVA_MAP_HOSTS, RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";
import { siteFiles } from "~/lib/seo/files";
import routes from "~/routes";

import { LEGACY_MARKETING_ROUTES } from "./fixtures/legacy-marketing-routes";

interface RouteConfigEntry {
  path?: string;
  index?: boolean;
  children?: RouteConfigEntry[];
}

/** Every path app/routes.ts serves, dynamic segments kept as ":name". */
function foxhoundPaths(
  entries: RouteConfigEntry[],
  parent = "",
  out = new Set<string>(),
): Set<string> {
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
  it("sends every Recova path to a path Foxhound serves", async () => {
    const shapes = new Set([...SERVED].map((p) => p.replace(/:[^/]+/g, ":")));
    for (const entry of RECOVA_REDIRECT_MAP) {
      const shape = entry.to.replace(/:[^/]+/g, ":");
      // A concrete post address (/blog/foxhound-vs-churnkey) is served by /blog/:slug.
      // robots.txt is answered before React Router, by the standard files.
      const served =
        shapes.has(shape) ||
        shapes.has(shape.replace(/\/[^/:]+$/, "/:")) ||
        (await siteFiles(new Request(`https://foxhoundapp.com${entry.to}`))) !== null;
      expect(served, `${entry.from} -> ${entry.to}`).toBe(true);
    }
  });

  it("is same path, new domain for every Recova path Foxhound serves (ruling 408 binding 3)", () => {
    const named = RECOVA_REDIRECT_MAP.filter((e) => e.to !== e.from).map((e) => e.from);
    expect(named.sort()).toEqual(
      [
        // Recova's four comparison posts, at their foxhound-vs-* slugs.
        "/blog/recova-vs-churn-buster",
        "/blog/recova-vs-churnkey",
        "/blog/recova-vs-paddle-retain",
        "/blog/recova-vs-stripe-smart-retries",
        "/blog/rss.xml",
        "/blog/sitemap.xml",
        "/disputes/demo",
        "/intelligence/demo",
        "/recovery/demo",
        // Recova's own next.config.ts redirects, one hop to its destination.
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
      expect(
        mappedFroms.has(route.url),
        `missing redirect mapping for ${route.url} (${route.sourceFile})`,
      ).toBe(true);
    }
  });

  it("has no entries beyond the fixture's routes and Recova's config redirects (map and inputs stay in sync)", () => {
    const fixtureUrls = new Set([
      ...LEGACY_MARKETING_ROUTES.map((r) => r.url),
      ...RECOVA_CONFIG_REDIRECTS.filter((r) => !r.host).map((r) => r.source),
      // The four renamed comparison posts, each a concrete /blog/:slug address.
      ...RECOVA_REDIRECT_MAP.filter((e) => e.from.startsWith("/blog/recova-vs-")).map(
        (e) => e.from,
      ),
    ]);
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(
        fixtureUrls.has(entry.from),
        `${entry.from} is mapped but not in the legacy-routes fixture`,
      ).toBe(true);
    }
  });

  it("has no duplicate source paths", () => {
    const froms = RECOVA_REDIRECT_MAP.map((e) => e.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("every target path is a real Foxhound path starting with /", () => {
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(entry.to.startsWith("/")).toBe(true);
    }
  });
});

// Recova's config redirects (J23), checked in the map that carries them.
describe("RECOVA_REDIRECT_MAP and Recova's config redirects", () => {
  it("no map target is itself a redirect source, so nothing chains", () => {
    const froms = new Set(RECOVA_CONFIG_REDIRECTS.filter((r) => !r.host).map((r) => r.source));
    for (const e of RECOVA_REDIRECT_MAP)
      expect(froms.has(e.to), `${e.from} -> ${e.to}`).toBe(false);
  });

  it("serves the same map on app.recovamrr.com, Recova's path-preserving host rule", () => {
    expect(RECOVA_MAP_HOSTS).toEqual(["recovamrr.com", "app.recovamrr.com"]);
  });

  it("refuses a config redirect onto the home page instead of deciding it (ruling 408 binding 4)", () => {
    const served = new Set(["/", "/docs"]);
    expect(() =>
      deriveRecovaMap([], served, [{ source: "/old-home", destination: "/", permanent: true }]),
    ).toThrow(/home page/);
  });

  it("refuses a config redirect to a path Foxhound does not serve", () => {
    expect(() =>
      deriveRecovaMap([], new Set(["/docs"]), [
        { source: "/x", destination: "/nowhere", permanent: true },
      ]),
    ).toThrow(/does not serve/);
  });
});
