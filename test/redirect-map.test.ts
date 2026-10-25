import { describe, expect, it } from "vitest";

import { BLOG_SLUG_REDIRECTS } from "~/lib/blog/slug-redirects";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { deriveRecovaMap, deriveRecovaMapHosts, renderRecovaMapSource } from "~/lib/redirects/derive-recova-map";
import { RECOVA_CONFIG_REDIRECTS } from "~/lib/redirects/recova-config-redirects";
import { recovaRedirect } from "~/lib/redirects/recova-edge";
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
  // `npm run gen:recova-map` (vitest --update) rewrites the file from here.
  it("is the committed file, regenerated from its inputs (RULES.md 7.3)", async () => {
    const source = renderRecovaMapSource(
      deriveRecovaMap(LEGACY_MARKETING_ROUTES, SERVED, RECOVA_CONFIG_REDIRECTS),
      deriveRecovaMapHosts(RECOVA_CONFIG_REDIRECTS),
    );
    await expect(source).toMatchFileSnapshot("../app/lib/redirects/recova-map.ts");
  });

  it("sends every Recova path to a path Foxhound serves", () => {
    // A served ":param" segment accepts any segment, so /blog/foxhound-vs-churnkey
    // is served by /blog/:slug.
    const segs = (p: string) => p.split("/").filter(Boolean).map((s) => (s.startsWith(":") ? ":" : s));
    const served = (to: string) =>
      [...SERVED].some((p) => {
        const want = segs(p);
        const got = segs(to);
        return want.length === got.length && want.every((s, i) => s === ":" || s === got[i]);
      });
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(served(entry.to), `${entry.from} -> ${entry.to}`).toBe(true);
    }
  });

  it("is same path, new domain for every Recova path Foxhound serves (ruling 408 binding 3)", () => {
    const named = RECOVA_REDIRECT_MAP.filter((e) => e.to !== e.from).map((e) => e.from);
    expect(named.sort()).toEqual(
      [
        "/blog/rss.xml",
        "/blog/sitemap.xml",
        // The four renamed comparison posts (376 item 21), one hop to the new slug.
        ...Object.keys(BLOG_SLUG_REDIRECTS).map((slug) => `/blog/${slug}`),
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
      ...Object.keys(BLOG_SLUG_REDIRECTS).map((slug) => `/blog/${slug}`),
    ]);
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(fixtureUrls.has(entry.from), `${entry.from} is mapped but not in the legacy-routes fixture`).toBe(true);
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

// What a visitor on an old address actually gets, through the function the
// Worker calls first on every request.
describe("recovaRedirect, served on Recova's hosts at cutover", () => {
  const at = (url: string) => {
    const response = recovaRedirect(new Request(url));
    return response && { status: response.status, location: response.headers.get("location") };
  };

  it("answers every fixed map entry with one 301 to its foxhoundapp.com address", () => {
    for (const { from, to } of RECOVA_REDIRECT_MAP) {
      if (from.includes(":")) continue;
      expect(at(`https://recovamrr.com${from}`), from).toEqual({ status: 301, location: `https://foxhoundapp.com${to}` });
    }
  });

  it("keeps blog posts and tags post to post, and sends a renamed post straight to its new slug", () => {
    expect(at("https://recovamrr.com/blog/stripe-failed-payment-recovery")?.location).toBe(
      "https://foxhoundapp.com/blog/stripe-failed-payment-recovery",
    );
    expect(at("https://recovamrr.com/blog/tag/decline-codes")?.location).toBe("https://foxhoundapp.com/blog/tag/decline-codes");
    expect(at("https://recovamrr.com/blog/recova-vs-churnkey")?.location).toBe("https://foxhoundapp.com/blog/foxhound-vs-churnkey");
    expect(at("https://recovamrr.com/blog/archive")?.location).toBe("https://foxhoundapp.com/blog/archive");
  });

  it("answers on www and app hosts too, keeps the query, and ignores case and a trailing slash", () => {
    expect(at("https://www.recovamrr.com/Pricing/")?.location).toBe("https://foxhoundapp.com/pricing");
    expect(at("https://app.recovamrr.com/user-guides/recovery?ref=x")?.location).toBe(
      "https://foxhoundapp.com/docs/recovery?ref=x",
    );
    expect(at("https://recovamrr.com/og?type=blog")?.location).toBe("https://foxhoundapp.com/og?type=blog");
  });

  it("keeps an unmapped path on the new domain and never leaves foxhoundapp.com", () => {
    expect(at("https://recovamrr.com/api/whatever")?.location).toBe("https://foxhoundapp.com/api/whatever");
    expect(at("https://recovamrr.com//evil.example/x")?.location).toBe("https://foxhoundapp.com/evil.example/x");
  });

  it("leaves Foxhound's own hosts alone", () => {
    expect(recovaRedirect(new Request("https://foxhoundapp.com/pricing"))).toBeNull();
    expect(recovaRedirect(new Request("https://www.foxhoundapp.com/"))).toBeNull();
  });
});
