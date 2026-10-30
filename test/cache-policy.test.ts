import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applyCachePolicy,
  CACHE_DIRECTIVES,
  classifyPath,
  hasSessionCookie,
  PRIVATE_DIRECTIVE,
  resolveCacheControl,
  VARY_HEADER_VALUE,
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
  ["/audit", "marketing"],
  ["/products", "marketing"],
  ["/product/recovery", "marketing"],
  ["/products/recovery", "marketing"],
  ["/compare", "marketing"],
  ["/compare/chargeflow", "marketing"],
  ["/decline-codes", "marketing"],
  ["/decline-codes/card_declined", "marketing"],
  ["/demos", "marketing"],
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
  "/demos/dashboard",
  "/recovery/payments/export.csv",
];

function request(path: string, cookie?: string): Request {
  return new Request(`https://foxhoundapp.com${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("PLANT 1: an anonymous request gets the public directive", () => {
  it.each(PUBLIC_ROUTES)("%s is %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
    expect(resolveCacheControl(request(path))).toBe(
      CACHE_DIRECTIVES[expected as keyof typeof CACHE_DIRECTIVES],
    );
  });

  it("blog is SHORTER than marketing, because posts change without a deploy", () => {
    expect(CACHE_DIRECTIVES.blog).toBe("public, max-age=60, stale-while-revalidate=600");
    expect(CACHE_DIRECTIVES.marketing).toBe("public, max-age=300, stale-while-revalidate=3600");
  });
});

describe("PLANT 2: A SIGNED-IN REQUEST NEVER GETS A PUBLIC DIRECTIVE", () => {
  it.each(PUBLIC_ROUTES)("%s is private with a PRODUCTION session cookie", (path) => {
    expect(resolveCacheControl(request(path, PROD_COOKIE))).toBe(PRIVATE_DIRECTIVE);
  });

  it.each(PUBLIC_ROUTES)("%s is private with a LOCAL session cookie", (path) => {
    expect(resolveCacheControl(request(path, LOCAL_COOKIE))).toBe(PRIVATE_DIRECTIVE);
  });

  it("it is found among OTHER cookies, not only when it is alone", () => {
    expect(
      hasSessionCookie(request("/", `theme=dark; ${PROD_COOKIE}; demo=1`)),
    ).toBe(true);
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

  it("the value is the literal Cookie, asserted directly", () => {
    expect(VARY_HEADER_VALUE).toBe("Cookie");
  });
});

describe("PLANT 7: the policy is applied at the one choke point", () => {
  it("the fetch entry applies it to both the rate-limited and the handled response", () => {
    const source = readFileSync("workers/app.ts", "utf8");
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(limited, nonce, origin))");
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(response, nonce, origin))");
  });
});
