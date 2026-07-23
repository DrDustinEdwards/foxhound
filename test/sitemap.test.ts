import { describe, expect, it } from "vitest";

import { STATIC_PAGES } from "~/routes/files/sitemap";
import routes from "~/routes";

// Drift-prevention guard for /sitemap.xml (same pattern as
// test/nav-manifest.test.ts and test/marketing-nav.test.ts):
// TASK-foxhound-seo-remediation.md M4 fixes foxhound-audit-seo.md's finding
// that /features existed, rendered real content, and set its own canonical
// tag, yet was missing from sitemap.ts's STATIC_PAGES - a silent omission,
// not a deliberate exclusion. This test walks the real route tree and
// asserts every static (non-parameterized) public marketing route is either
// in STATIC_PAGES or in the EXCLUDED_PREFIXES list below, so the same class
// of drift fails CI instead of shipping quietly.

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

// Every route NOT expected to appear in /sitemap.xml, grouped and documented
// by reason (task rule: "Exclusions ... must be an explicit documented list,
// not omissions"). Matched by prefix, so a parameterized child (e.g.
// /recovery/payments/:id) is covered by its parent's entry (/recovery).
const EXCLUDED_PREFIXES = [
  // Authenticated app shell + admin: never public, never crawlable, and
  // already Disallow'd in robots.txt.
  "/dashboard",
  "/recovery",
  "/disputes",
  "/intelligence",
  "/billing",
  "/settings",
  "/help",
  "/welcome",
  "/admin",
  // Auth flow (login/signup/password reset/OAuth/team invite/logout): no SEO
  // value, and robots.txt Disallows every one of these.
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/connect",
  "/invite",
  "/auth/",
  "/logout",
  // Public-utility, token-signed one-off links (card update, unsubscribe,
  // engagement-tracking pixels/redirects): not a discoverable page, nothing
  // to index.
  "/u/",
  "/p/",
  "/e/",
  // Demo entry actions: each sets a cookie and redirects into the app shell
  // (real GET anchors as of TASK-foxhound-demo-entry-parity.md item 1, so
  // crawlers can follow them, but the redirect target is the same
  // authenticated-app path excluded above, nothing distinct to index here).
  // Webhooks are POST-only, signature-verified endpoints.
  "/demo/exit",
  "/demos/dashboard",
  "/demos/recovery",
  "/demos/disputes",
  "/demos/intelligence",
  "/webhooks/",
  // Machine-readable files: either not HTML (llms*.txt, feed.rss, og/*
  // images) or the sitemap/robots routes themselves.
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/feed.rss",
  "/og/",
];

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

describe("/sitemap.xml stays in sync with the real route tree", () => {
  const realPaths = new Set<string>();
  collectPaths(routes as unknown as RouteConfigEntry[], "", realPaths);
  const staticPagePaths = new Set(STATIC_PAGES.map((p) => p.path));

  it("found a sane number of real routes (fixture is walking something)", () => {
    expect(realPaths.size).toBeGreaterThan(20);
  });

  it("every static, non-excluded public route appears in STATIC_PAGES", () => {
    const missing: string[] = [];
    for (const path of realPaths) {
      const isDynamic = path.includes(":") || path.includes("*");
      if (isDynamic || isExcluded(path)) continue;
      if (!staticPagePaths.has(path)) missing.push(path);
    }
    expect(missing, `missing from sitemap.ts STATIC_PAGES: ${missing.join(", ")}`).toEqual([]);
  });

  it("/features is present (foxhound-audit-seo.md M2)", () => {
    expect(staticPagePaths.has("/features")).toBe(true);
  });

  it("/blog/archive is present (foxhound-audit-parity.md Cluster B fix 3)", () => {
    expect(staticPagePaths.has("/blog/archive")).toBe(true);
  });

  it("every STATIC_PAGES entry is a real route", () => {
    for (const page of STATIC_PAGES) {
      expect(realPaths.has(page.path), `${page.path} (sitemap STATIC_PAGES) is not in routes.ts`).toBe(true);
    }
  });
});
