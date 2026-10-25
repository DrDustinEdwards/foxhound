import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import { deriveRecovaMap } from "~/lib/redirects/derive-recova-map";
import {
  RECOVA_CONFIG_REDIRECTS,
  resolveRecovaConfigRedirect,
} from "~/lib/redirects/recova-config-redirects";
import { RECOVA_MAP_HOSTS, RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";
import routes from "~/routes";
import { loader } from "~/routes/redirects/recova-config";

// J23 (job_5bfb8ff4fc7d, ledger row F17): Recova's seven config-level
// redirects, read in its next.config.ts (blob 8cf9b0c7, 5541 bytes):
//   /recovery/audit           -> /audit           permanent
//   /recovery/audit/connect   -> /audit/connect   permanent
//   /recovery/audit/results   -> /audit/results   permanent
//   app.recovamrr.com/:path*  -> https://recovamrr.com/:path*  permanent
//   /user-guides/:path*       -> /docs/:path*     permanent
//   /user-guides              -> /docs            permanent
//   /sitemap_index.xml        -> /sitemap.xml     permanent
// Next.js answers `permanent: true` with 308 and keeps the query string.

const ORIGIN = "https://foxhoundapp.com";

interface RouteConfigEntry {
  id?: string;
  path?: string;
  index?: boolean;
  file: string;
  children?: RouteConfigEntry[];
}

function toRouteObjects(entries: RouteConfigEntry[]): RouteObject[] {
  return entries.map((e, i) => {
    const base = { id: `${e.file}#${i}`, handle: { file: e.file } };
    if (e.index) return { ...base, index: true, path: e.path } as RouteObject;
    return { ...base, path: e.path, children: e.children ? toRouteObjects(e.children) : undefined } as RouteObject;
  });
}

const ROUTE_OBJECTS = toRouteObjects(routes as unknown as RouteConfigEntry[]);

function moduleFor(pathname: string): string | null {
  const matches = matchRoutes(ROUTE_OBJECTS, pathname);
  if (!matches || matches.length === 0) return null;
  return (matches[matches.length - 1]!.route.handle as { file: string }).file;
}

const REDIRECT_MODULE = "./routes/redirects/recova-config.ts";

async function served(path: string): Promise<{ status: number; location: string | null }> {
  const request = new Request(`${ORIGIN}${path}`);
  let response: Response;
  try {
    response = (await loader({ request, params: {}, context: {} } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) response = thrown;
    else throw thrown;
  }
  return { status: response.status, location: response.headers.get("location") };
}

// [request path, Location Foxhound must answer with]
const CASES: Array<[string, string]> = [
  ["/recovery/audit", "/audit"],
  ["/recovery/audit/connect", "/audit/connect"],
  ["/recovery/audit/results", "/audit/results"],
  ["/user-guides", "/docs"],
  ["/user-guides/recovery", "/docs/recovery"],
  ["/user-guides/getting-started/first-steps", "/docs/getting-started/first-steps"],
  ["/sitemap_index.xml", "/sitemap.xml"],
];

describe("Recova's next.config.ts redirects, served by Foxhound (J23, F17)", () => {
  it("transcribes all seven, every one permanent", () => {
    expect(RECOVA_CONFIG_REDIRECTS).toHaveLength(7);
    expect(RECOVA_CONFIG_REDIRECTS.every((r) => r.permanent)).toBe(true);
  });

  for (const [path, location] of CASES) {
    it(`${path} answers one 308 to ${location}`, () => {
      expect(resolveRecovaConfigRedirect(path)).toEqual({ location, status: 308 });
    });
  }

  it("matches the way the router does: any case, a trailing slash, percent-encoding", () => {
    expect(resolveRecovaConfigRedirect("/Recovery/Audit/")?.location).toBe("/audit");
    expect(resolveRecovaConfigRedirect("/recovery/%61udit")?.location).toBe("/audit");
    expect(resolveRecovaConfigRedirect("/user-guides/")?.location).toBe("/docs");
  });

  it("never redirects onto the home page (ruling 408 binding 4)", () => {
    for (const r of RECOVA_CONFIG_REDIRECTS) {
      if (r.host) continue;
      expect(r.destination, r.source).not.toBe("/");
    }
  });

  for (const [path, location] of CASES) {
    it(`${path} reaches the redirect module through app/routes.ts, which answers 308 to ${location}`, async () => {
      expect(moduleFor(path)).toBe(REDIRECT_MODULE);
      expect(await served(path)).toEqual({ status: 308, location });
    });
  }

  it("leaves Foxhound's own pages where they are", () => {
    expect(moduleFor("/audit")).not.toBe(REDIRECT_MODULE);
    expect(moduleFor("/docs/recovery")).not.toBe(REDIRECT_MODULE);
    expect(moduleFor("/sitemap.xml")).not.toBe(REDIRECT_MODULE);
    expect(moduleFor("/recovery/dashboard")).not.toBe(REDIRECT_MODULE);
  });
});

describe("the cutover map carries the seven in one hop (CUTOVER-PLAN.md: F17 folds into the map)", () => {
  it("maps each path rule straight to Recova's final destination, never via Foxhound's own redirect", () => {
    const to = (from: string) => RECOVA_REDIRECT_MAP.find((e) => e.from === from)?.to;
    expect(to("/recovery/audit")).toBe("/audit");
    expect(to("/recovery/audit/connect")).toBe("/audit/connect");
    expect(to("/recovery/audit/results")).toBe("/audit/results");
    expect(to("/user-guides/:path*")).toBe("/docs/:path*");
    expect(to("/user-guides")).toBe("/docs");
    expect(to("/sitemap_index.xml")).toBe("/sitemap.xml");
  });

  it("no map target is itself a redirect source, so nothing chains", () => {
    const froms = new Set(RECOVA_CONFIG_REDIRECTS.filter((r) => !r.host).map((r) => r.source));
    for (const e of RECOVA_REDIRECT_MAP) expect(froms.has(e.to), `${e.from} -> ${e.to}`).toBe(false);
  });

  it("serves the same map on www and app.recovamrr.com, Recova's path-preserving host moves", () => {
    expect(RECOVA_MAP_HOSTS).toEqual(["recovamrr.com", "www.recovamrr.com", "app.recovamrr.com"]);
  });

  it("refuses a config redirect onto the home page instead of deciding it (ruling 408 binding 4)", () => {
    const served = new Set(["/", "/docs"]);
    expect(() =>
      deriveRecovaMap([], served, [{ source: "/old-home", destination: "/", permanent: true }]),
    ).toThrow(/home page/);
  });

  it("refuses a config redirect to a path Foxhound does not serve", () => {
    expect(() =>
      deriveRecovaMap([], new Set(["/docs"]), [{ source: "/x", destination: "/nowhere", permanent: true }]),
    ).toThrow(/does not serve/);
  });
});
