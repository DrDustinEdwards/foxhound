import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHARED_CACHE_CONTROL } from "@dustinedwards/site-runtime/edge-cache";

import {
  applyCachePolicy,
  CACHE_DIRECTIVES,
  classifyPath,
  edgeCacheable,
  edgeRequest,
  hasSessionCookie,
  PRIVATE_DIRECTIVE,
  resolveCacheControl,
} from "~/lib/http/cache-policy";

// SESSION 53 / 345 binding 4: the response cache policy, shipped BEFORE the
// cache is enabled.
//
// THE ONE ASSERTION EVERYTHING ELSE SERVES: a request carrying a session cookie
// never receives a public directive, on any route. Cloudflare bypasses on
// Set-Cookie and Authorization but NOT on a request Cookie header, and the
// marketing layout renders the signed-in switcher on the same URLs anonymous
// visitors fetch, so a cached signed-in render of / would be served to a
// stranger. The platform will not stop that; this policy is what does.

/** Production's cookie name, with the __Secure- prefix Better Auth applies on
 *  https. A matcher written against the LOCAL name would miss this one and
 *  classify every signed-in production request as anonymous. */
const PROD_COOKIE = "__Secure-better-auth.session_token=abc123";
const LOCAL_COOKIE = "better-auth.session_token=abc123";

const PUBLIC_ROUTES = [
  ["/", "marketing"],
  ["/pricing", "marketing"],
  ["/features", "marketing"],
  ["/about", "marketing"],
  ["/privacy", "marketing"],
  ["/terms", "marketing"],
  ["/products", "marketing"],
  ["/product/recovery", "marketing"],
  ["/products/recovery", "marketing"],
  ["/compare", "marketing"],
  ["/compare/chargeflow", "marketing"],
  ["/decline-codes", "marketing"],
  ["/decline-codes/card_declined", "marketing"],
  ["/docs", "docs"],
  ["/docs/recovery", "docs"],
  ["/blog", "blog"],
  ["/blog/archive", "blog"],
  ["/blog/tag/recovery", "blog"],
  ["/blog/some-post", "blog"],
  ["/sitemap.xml", "files"],
  ["/robots.txt", "files"],
  ["/llms.txt", "files"],
  ["/llms-full.txt", "files"],
  ["/feed.rss", "files"],
  ["/og/anything", "files"],
  // Recova's card URL shape: the type rides in the query.
  ["/og", "files"],
] as const;

/** Every PRIVATE-class route, including the ones added after 345 was written. */
const PRIVATE_ROUTES = [
  "/console",
  "/recovery/dashboard",
  "/recovery/sequence",
  "/recovery/payments",
  "/recovery/payments/abc",
  "/recovery/winback",
  "/recovery/expiring-cards",
  "/disputes/dashboard",
  "/disputes/abc",
  "/intelligence/dashboard",
  "/intelligence/customers",
  "/billing",
  "/billing/invoices/abc",
  // Sessions 42 to 46.
  "/settings",
  "/settings/team",
  "/settings/audit",
  "/settings/email",
  "/settings/alerts",
  "/settings/api-keys",
  "/settings/brand-voice",
  "/help",
  "/welcome",
  "/admin",
  "/admin/merchants",
  "/admin/operations",
  "/admin/blog",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/connect",
  "/connect/callback",
  // Session 51's second half of phase (d).
  "/connect/additional",
  "/invite/tok",
  "/auth/google",
  "/auth/google/callback",
  "/api/auth/session",
  "/api/theme",
  "/api/account/switch",
  "/logout",
  "/demo/exit",
  "/u/tok",
  // The card-update page, alert AND resubscribe modes.
  "/p/tok",
  "/e/o/tok",
  "/e/c/tok",
  "/webhooks/stripe",
  "/marketing/generate-email-sample",
  // Under the marketing layout, but the estimator and the demo's door.
  "/audit",
  "/demos",
  "/demos/dashboard",
  "/recovery/payments/export.csv",
];

function request(path: string, cookie?: string): Request {
  return new Request(`https://foxhoundapp.com${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("PLANT 1: an anonymous page is shared only as the Renderer rendered it", () => {
  it.each(PUBLIC_ROUTES)("%s is %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
    const directive = expected === "files" ? CACHE_DIRECTIVES.files : SHARED_CACHE_CONTROL;
    expect(resolveCacheControl(request(path), true)).toBe(directive);
  });

  it("a page the gateway rendered (with its nonce) is never shared", () => {
    expect(resolveCacheControl(request("/pricing"))).toBe(PRIVATE_DIRECTIVE);
  });

  it("a shared page carries the edge lifetime and the purge tag; one that sets a cookie does not", () => {
    const shared = applyCachePolicy(request("/pricing"), new Response("x"), true);
    expect(shared.headers.get("Cloudflare-CDN-Cache-Control")).toMatch(/^max-age=\d+/);
    expect(shared.headers.get("Cache-Tag")).toBe("pages");
    const cookied = applyCachePolicy(request("/pricing"), new Response("x", { headers: { "Set-Cookie": "a=1" } }), true);
    expect(cookied.headers.get("Cache-Control")).toBe(PRIVATE_DIRECTIVE);
    expect(cookied.headers.get("Cache-Tag")).toBeNull();
  });
});

describe("PLANT 2: A SIGNED-IN REQUEST NEVER GETS A PUBLIC DIRECTIVE", () => {
  const PAGES = PUBLIC_ROUTES.filter(([, c]) => c !== "files");

  it.each(PAGES)("%s is private with a PRODUCTION session cookie", (path) => {
    expect(resolveCacheControl(request(path, PROD_COOKIE), true)).toBe(PRIVATE_DIRECTIVE);
  });

  it.each(PAGES)("%s is private with a LOCAL session cookie", (path) => {
    expect(resolveCacheControl(request(path, LOCAL_COOKIE), true)).toBe(PRIVATE_DIRECTIVE);
  });

  it("it is found among OTHER cookies, not only when it is alone", () => {
    expect(
      hasSessionCookie(request("/", `theme=dark; ${PROD_COOKIE}; demo=1`)),
    ).toBe(true);
  });
});

describe("PLANT 8: the gateway sends only an anonymous GET of a public page to the cache", () => {
  it.each(PUBLIC_ROUTES)("%s goes to the Renderer when anonymous", (path) => {
    expect(edgeCacheable(request(path))).toBe(true);
    expect(edgeCacheable(request(path, "fh_theme=light"))).toBe(true);
  });

  it.each(PUBLIC_ROUTES)("%s stays in the gateway with a session cookie, or any other cookie", (path) => {
    expect(edgeCacheable(request(path, PROD_COOKIE))).toBe(false);
    expect(edgeCacheable(request(path, `fh_theme=dark; ${LOCAL_COOKIE}`))).toBe(false);
    expect(edgeCacheable(request(path, "fh_demo=1"))).toBe(false);
  });

  it.each(PRIVATE_ROUTES)("%s stays in the gateway", (path) => {
    expect(edgeCacheable(request(path))).toBe(false);
  });

  it("writes, HEAD and the media library stay in the gateway", () => {
    expect(edgeCacheable(new Request("https://foxhoundapp.com/pricing", { method: "POST" }))).toBe(false);
    expect(edgeCacheable(new Request("https://foxhoundapp.com/pricing", { method: "HEAD" }))).toBe(false);
    expect(edgeCacheable(request("/media/a.png"))).toBe(false);
  });

  it("the Renderer sees only the theme, and the theme is in the key", () => {
    const dark = edgeRequest(request("/pricing"), "/pricing");
    const light = edgeRequest(request("/pricing?x=1", "fh_theme=light"), "/pricing?x=1");
    expect(dark.request.headers.get("cookie")).toBe("fh_theme=dark");
    expect(dark.cacheKey).toBe("/pricing?fh-theme-key=dark");
    expect(light.request.headers.get("cookie")).toBe("fh_theme=light");
    expect(light.cacheKey).toBe("/pricing?x=1&fh-theme-key=light");
  });
});

describe("PLANT 6: Vary: Cookie keys the cache by session presence (348)", () => {
  // THE HEADER THE CACHE-CONTROL POLICY COULD NOT REPLACE. The Worker does not
  // run on a cache hit, so a directive computed inside it cannot govern what is
  // SERVED. Vary moves the decision into the cache key, which is the only layer
  // that runs on a hit.

  it.each(PUBLIC_ROUTES)("%s carries Vary: Cookie when anonymous", (path) => {
    const applied = applyCachePolicy(request(path), new Response("x"));
    expect(applied.headers.get("Vary")).toBe("Cookie");
  });

  it.each(PRIVATE_ROUTES)("%s does NOT gain Vary", (path) => {
    const applied = applyCachePolicy(request(path), new Response("x"));
    expect(applied.headers.get("Vary")).toBeNull();
  });

  it("a PUBLIC route that sets its OWN Cache-Control still gets Vary", () => {
    // The files routes set their own directive and are still public-class, so
    // the question Vary answers still applies to them.
    const existing = new Response("x", {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
    const applied = applyCachePolicy(request("/robots.txt"), existing);
    expect(applied.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(applied.headers.get("Vary")).toBe("Cookie");
  });

  it("an EXISTING Vary is appended to, never clobbered, and never duplicated", () => {
    const withVary = new Response("x", { headers: { Vary: "Accept-Encoding" } });
    expect(applyCachePolicy(request("/"), withVary).headers.get("Vary")).toBe(
      "Accept-Encoding, Cookie",
    );

    const already = new Response("x", { headers: { Vary: "Cookie" } });
    expect(applyCachePolicy(request("/"), already).headers.get("Vary")).toBe("Cookie");

    const cased = new Response("x", { headers: { Vary: "cookie" } });
    expect(applyCachePolicy(request("/"), cased).headers.get("Vary")).toBe("cookie");
  });
});

describe("PLANT 7: the policy is applied at the one choke point", () => {
  it("the fetch entry applies it to the rate-limited, the handled and the Renderer's response", () => {
    const source = readFileSync("workers/app.ts", "utf8");
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(limited, nonce, origin))");
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(response, nonce, origin))");
    expect(source).toContain("settleCacheHeaders(withPreloads(applyCachePolicy(request, secured, true)))");
  });
});
