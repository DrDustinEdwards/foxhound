import { describe, expect, it } from "vitest";

import { INDEXNOW_KEY_PATH } from "~/lib/seo/indexnow-key";
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
  "/console",
  // The audit's authenticated surfaces, plus the anonymous OAuth pair and the
  // live results page (phase (f)). A bare "/audit" would also exclude the
  // PUBLIC estimator, which is the one page here that should be indexed.
  // Legacy's own sitemap lists /audit and none of these, which is the same
  // call: a consent screen, an OAuth return and a cookie-gated render are
  // steps inside a flow, not pages a crawler should land on.
  "/audit/history",
  "/audit/runs/",
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
  // POST-only action route (home page's live email generator); nothing to
  // index, same reasoning as /demo/exit.
  "/marketing/generate-email-sample",
  "/webhooks/",
  // API resource routes: action-only JSON endpoints, no HTML, nothing to
  // index. Covers /api/theme (ruling 59's theme persistence write) and
  // /api/auth/*. Note the auth one is a wildcard so it was already skipped as
  // non-static; this prefix is what classifies the STATIC ones, and /api/theme
  // is the first of those.
  "/api/",
  // Machine-readable files: either not HTML (llms*.txt, feed.rss, og/*
  // images) or the sitemap/robots routes themselves.
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/feed.rss",
  "/og/",
  // Recova's next.config.ts redirects (J23): /user-guides and
  // /sitemap_index.xml answer a 308 and are not pages. Recova's own sitemap
  // lists neither. (/recovery/audit is already covered by "/recovery".)
  "/user-guides",
  "/sitemap_index.xml",
  // JSON health for monitors (job_f7f35d4b7ac7), not a page.
  "/health",
  // RFC 9116's well-known file (377 item 11). Not HTML, and not a page a reader
  // navigates to: a client looks for it at a fixed path by the spec, so listing
  // it in the sitemap would advertise a file that is found by convention.
  // The /security PAGE it points at IS in STATIC_PAGES.
  "/.well-known/",
  // The IndexNow key file (job_b0b24df12155). A verification file the engines
  // fetch by the protocol's convention, not a page; Recova's sitemap leaves its
  // own key file out too.
  INDEXNOW_KEY_PATH,
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
