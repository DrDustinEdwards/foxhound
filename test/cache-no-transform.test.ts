import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { applyCachePolicy, NO_TRANSFORM_PREFIXES } from "~/lib/http/cache-policy";

// job_0927572db276: signed-in and token HTML carries Cache-Control no-transform
// so Cloudflare Web Analytics does not inject its beacon. Public pages and
// assets must NOT carry it (it also disables compression).

function html(path: string, init?: HeadersInit): Response {
  const request = new Request(`https://foxhoundapp.com${path}`);
  const response = new Response("<html></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8", ...init },
  });
  return applyCachePolicy(request, response);
}

function cacheControl(response: Response): string {
  return response.headers.get("Cache-Control") ?? "";
}

describe("no-transform on signed-in and token HTML", () => {
  it.each([
    "/console",
    "/recovery/dashboard",
    "/disputes/dashboard",
    "/intelligence/dashboard",
    "/recovery/payments/pay_1",
    "/disputes/dp_1",
    "/intelligence/churn",
    "/billing/invoices/in_1",
    "/settings/team",
    "/audit/dashboard",
    "/audit/runs/run_1",
    "/audit/results/run_1",
    "/help",
    "/welcome",
    "/admin",
    "/admin/merchants/m_1",
    "/p/sometoken",
    "/u/sometoken",
    "/invite/sometoken",
    "/reset-password",
  ])("%s carries no-transform once", (path) => {
    const response = html(path);
    expect(cacheControl(response)).toContain("no-transform");
    expect(cacheControl(response)).toContain("no-store");
    expect(cacheControl(response).split("no-transform").length).toBe(2);
  });

  it("merges into a route's own Cache-Control instead of adding a second header", () => {
    const response = html("/p/sometoken", { "Cache-Control": "no-store" });
    expect(cacheControl(response)).toBe("no-store, no-transform");
    expect([...response.headers].filter(([k]) => k.toLowerCase() === "cache-control")).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = html("/console", { "Cache-Control": "private, no-store, no-transform" });
    expect(cacheControl(once)).toBe("private, no-store, no-transform");
  });

  it("a prefix does not match a longer sibling word (/helpful, /pay)", () => {
    expect(cacheControl(html("/helpful"))).not.toContain("no-transform");
    expect(cacheControl(html("/paywall"))).not.toContain("no-transform");
  });

  it("every top-level route of the app-shell layout is covered", () => {
    const source = readFileSync("app/routes.ts", "utf8");
    const start = source.indexOf('id: "app-shell"');
    const end = source.indexOf("// Demo exit");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const segments = new Set<string>();
    // Direct children of the layout (indent 4), plus the prefixes that sit
    // inside nested layouts (settings, and admin's own shell, which follows the
    // app shell in routes.ts).
    for (const m of block.matchAll(/^ {4}(?:\.\.\.prefix|route)\("([a-z-]+)(?:\/[^"]*)?"/gm)) {
      segments.add(m[1]);
    }
    for (const m of block.matchAll(/prefix\("(settings|admin)"/g)) segments.add(m[1]);
    expect(segments.size).toBeGreaterThan(5);
    for (const segment of segments) {
      const covered = NO_TRANSFORM_PREFIXES.some((p) => p.startsWith(`/${segment}`));
      expect(covered, `/${segment} is in the app-shell layout but not in NO_TRANSFORM_PREFIXES`).toBe(true);
    }
  });
});
