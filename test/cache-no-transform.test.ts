import { describe, expect, it } from "vitest";

import { applyCachePolicy } from "~/lib/http/cache-policy";

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
    "/passkey",
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
});
