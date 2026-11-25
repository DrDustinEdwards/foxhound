import { describe, expect, it } from "vitest";

import { STATIC_PAGES } from "~/routes/files/sitemap";
import routes from "~/routes";

// Every static public route is in STATIC_PAGES or in the excluded list below.

interface RouteConfigEntry {
  path?: string;
  index?: boolean;
  file?: string;
  children?: RouteConfigEntry[];
}

function collectPaths(entries: RouteConfigEntry[], parentPath: string, out: Set<string>): void {
  for (const entry of entries) {
    let path = parentPath;
    if (entry.path) {
      const segment = entry.path.replace(/^\/+|\/+$/g, "");
      path = parentPath === "" ? `/${segment}` : `${parentPath}/${segment}`;
      out.add(path);
    } else if (entry.index) {
      out.add(parentPath === "" ? "/" : parentPath);
    }
    if (entry.children) collectPaths(entry.children, path, out);
  }
}

// Routes not expected in /sitemap.xml, matched by prefix.
const EXCLUDED_PREFIXES = [
  // The authenticated app and admin.
  "/console",
  "/audit/dashboard",
  "/audit/connect",
  "/audit/callback",
  "/audit/results",
  "/recovery",
  "/disputes",
  "/intelligence",
  "/billing",
  "/settings",
  "/help",
  "/welcome",
  "/admin",
  // Auth flow.
  "/login",
  "/signup",
  "/passkey",
  "/sign-in/",
  "/email/confirm",
  "/connect",
  "/invite",
  "/auth/",
  "/logout",
  // Token-signed links, demo entry actions, POST endpoints, webhooks, APIs.
  "/u/",
  "/p/",
  "/e/",
  "/demo/exit",
  "/demos/dashboard",
  "/demos/recovery",
  "/demos/disputes",
  "/demos/intelligence",
  "/marketing/generate-email-sample",
  "/webhooks/",
  "/api/",
  // Machine-readable files, redirects, monitors and OAuth.
  "/sitemap.xml",
  "/llms.txt",
  "/llms-full.txt",
  "/feed.rss",
  "/og/",
  "/og",
  "/user-guides",
  "/sitemap_index.xml",
  "/health",
  "/csp-report",
  "/oauth/",
  "/.well-known/",
];

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

describe("/sitemap.xml stays in sync with the real route tree", () => {
  const realPaths = new Set<string>();
  collectPaths(routes as unknown as RouteConfigEntry[], "", realPaths);
  const staticPagePaths = new Set(STATIC_PAGES.map((p) => p.path));

  it("every static, non-excluded public route appears in STATIC_PAGES", () => {
    const missing: string[] = [];
    for (const path of realPaths) {
      const isDynamic = path.includes(":") || path.includes("*");
      if (isDynamic || isExcluded(path)) continue;
      if (!staticPagePaths.has(path)) missing.push(path);
    }
    expect(missing, `missing from sitemap.ts STATIC_PAGES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every STATIC_PAGES entry is a real route", () => {
    for (const page of STATIC_PAGES) {
      expect(
        realPaths.has(page.path),
        `${page.path} (sitemap STATIC_PAGES) is not in routes.ts`,
      ).toBe(true);
    }
  });
});
