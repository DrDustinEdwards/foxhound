import { describe, expect, it } from "vitest";

import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { RECOVA_CONFIG_REDIRECTS } from "~/lib/redirects/recova-config-redirects";
import { deriveRecovaMap } from "~/lib/redirects/derive-recova-map";
import { RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";
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

// Coverage is checked against test/fixtures/legacy-marketing-routes.ts, a snapshot of the legacy route tree.

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
});

describe("RECOVA_REDIRECT_MAP and Recova's config redirects", () => {
  it("no map target is itself a redirect source, so nothing chains", () => {
    const froms = new Set(RECOVA_CONFIG_REDIRECTS.filter((r) => !r.host).map((r) => r.source));
    for (const e of RECOVA_REDIRECT_MAP)
      expect(froms.has(e.to), `${e.from} -> ${e.to}`).toBe(false);
  });

  it("refuses a config redirect onto the home page instead of deciding it", () => {
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
