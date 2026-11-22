import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";

// Foxhound serves Recova's paths, so the cutover map is "same path, new domain".
// The route tree is matched with React Router's own matchRoutes, so "this URL
// reaches this page module" is the router's answer, not a string comparison.

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
    return {
      ...base,
      path: e.path,
      children: e.children ? toRouteObjects(e.children) : undefined,
    } as RouteObject;
  });
}

const ROUTE_OBJECTS = toRouteObjects(routes as unknown as RouteConfigEntry[]);

/** The marketing layout's catch-all: matching it means the address answers 404. */
const NOT_FOUND = "./routes/not-found.tsx";

/** The page module a URL reaches, or null when only the 404 catch-all takes it. */
function moduleFor(pathname: string): string | null {
  const matches = matchRoutes(ROUTE_OBJECTS, pathname);
  if (!matches || matches.length === 0) return null;
  const file = (matches[matches.length - 1]!.route.handle as { file: string }).file;
  return file === NOT_FOUND ? null : file;
}

const NEW_PATHS: Array<[string, string]> = [
  ["/console", "./routes/app/dashboard.tsx"],
  ["/product/audit", "./routes/products/audit.tsx"],
  ["/product/recovery", "./routes/products/recovery.tsx"],
  ["/product/disputes", "./routes/products/disputes.tsx"],
  ["/product/intelligence", "./routes/products/intelligence.tsx"],
  ["/recovery/dashboard", "./routes/app/recovery/index.tsx"],
  ["/recovery/sequence", "./routes/app/recovery/sequences.tsx"],
  ["/disputes/dashboard", "./routes/app/disputes/index.tsx"],
  ["/intelligence/dashboard", "./routes/app/intelligence/index.tsx"],
  ["/admin/platform/crons", "./routes/admin/crons.tsx"],
  ["/admin/platform/webhooks", "./routes/admin/webhooks.tsx"],
  ["/admin/platform/audit-log", "./routes/admin/audit-log.tsx"],
  // Neighbours that must keep resolving beside the moved paths.
  ["/pricing", "./routes/pricing.tsx"],
  ["/products", "./routes/products/index.tsx"],
  ["/disputes/dp_123", "./routes/app/disputes/detail.tsx"],
];

// Foxhound's own former paths: none is served and none redirects.
const RETIRED_PATHS = [
  "/dashboard",
  "/recovery",
  "/recovery/sequences",
  "/disputes",
  "/intelligence",
  "/admin/crons",
  "/admin/webhooks",
  "/admin/audit-log",
  ...["audit", "recovery", "disputes", "intelligence"].map((spoke) => `/products/${spoke}`),
];

describe("URL map", () => {
  it("Foxhound serves Recova's paths", () => {
    expect(NEW_PATHS.map(([path]) => [path, moduleFor(path)])).toEqual(NEW_PATHS);
  });

  it("Foxhound's old paths reach no page", () => {
    expect(RETIRED_PATHS.map((path) => [path, moduleFor(path)])).toEqual(
      RETIRED_PATHS.map((path) => [path, null]),
    );
  });
});
