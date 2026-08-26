import { execSync } from "node:child_process";
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
] as const;

/** Every PRIVATE-class route, including the ones added after 345 was written. */
const PRIVATE_ROUTES = [
  "/dashboard",
  "/recovery",
  "/recovery/payments",
  "/recovery/payments/abc",
  "/recovery/winback",
  "/recovery/expiring-cards",
  "/disputes",
  "/disputes/abc",
  "/intelligence",
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

  it("THE PRIVATE DIRECTIVE IS `no-store`, asserted as a LITERAL", () => {
    // Every other assertion in this file compares against PRIVATE_DIRECTIVE, so
    // mutating the constant moved both sides and proved nothing. `no-store` is
    // the word that forbids storage outright; `private, max-age=0` still
    // permits a store-and-revalidate, which is not what this policy promises.
    expect(PRIVATE_DIRECTIVE).toBe("private, no-store");
    expect(resolveCacheControl(request("/dashboard"))).toBe("private, no-store");
    expect(resolveCacheControl(request("/", PROD_COOKIE))).toBe("private, no-store");
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

  it("the __Secure- prefix is stripped before matching, which is the production case", () => {
    expect(hasSessionCookie(request("/", PROD_COOKIE))).toBe(true);
    expect(hasSessionCookie(request("/", LOCAL_COOKIE))).toBe(true);
    expect(hasSessionCookie(request("/", "__Host-better-auth.session_token=x"))).toBe(true);
  });

  it("the cookie-cache cookies count too, not just session_token", () => {
    expect(hasSessionCookie(request("/", "__Secure-better-auth.session_data=x"))).toBe(true);
    expect(hasSessionCookie(request("/", "better-auth.account_data=x"))).toBe(true);
  });

  it("it is found among OTHER cookies, not only when it is alone", () => {
    expect(
      hasSessionCookie(request("/", `theme=dark; ${PROD_COOKIE}; demo=1`)),
    ).toBe(true);
  });

  it("a NON-session cookie alone leaves the route public, so the check discriminates", () => {
    expect(hasSessionCookie(request("/", "theme=dark"))).toBe(false);
    expect(resolveCacheControl(request("/", "theme=dark"))).toBe(CACHE_DIRECTIVES.marketing);
  });
});

describe("PLANT 3: every PRIVATE route is private, cookie or not", () => {
  it.each(PRIVATE_ROUTES)("%s is private anonymous", (path) => {
    expect(classifyPath(path)).toBe("private");
    expect(resolveCacheControl(request(path))).toBe(PRIVATE_DIRECTIVE);
  });

  it.each(PRIVATE_ROUTES)("%s is private signed in", (path) => {
    expect(resolveCacheControl(request(path, PROD_COOKIE))).toBe(PRIVATE_DIRECTIVE);
  });
});

describe("PLANT 4: an unclassified route defaults to PRIVATE", () => {
  it("a route that does not exist yet is private", () => {
    // The throwaway: no such route is registered, and it must still be private
    // rather than falling through to a public directive or to no header at all.
    expect(classifyPath("/some-route-added-tomorrow")).toBe("private");
    expect(resolveCacheControl(request("/some-route-added-tomorrow"))).toBe(PRIVATE_DIRECTIVE);
  });

  it("a near-miss on a public prefix is private, not public", () => {
    // `/blogging` must not inherit `/blog`'s directive.
    expect(classifyPath("/blogging")).toBe("private");
    expect(classifyPath("/docsy")).toBe("private");
    expect(classifyPath("/productsx")).toBe("private");
  });

  it("EVERY response leaves with an explicit directive, so nothing is left to heuristics", () => {
    const applied = applyCachePolicy(request("/anything"), new Response("x"));
    expect(applied.headers.get("Cache-Control")).toBe(PRIVATE_DIRECTIVE);
  });
});

describe("PLANT 5: routes that set their own directive keep it", () => {
  it("a files route's existing value is not overwritten", () => {
    const existing = new Response("x", {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
    expect(applyCachePolicy(request("/sitemap.xml"), existing).headers.get("Cache-Control")).toBe(
      "public, max-age=3600",
    );
  });

  it("THE UTILITY no-store VALUES ARE UNCHANGED, in the source and through the policy", () => {
    const utility = [
      "app/routes/utility/card-update.tsx",
      "app/routes/utility/unsubscribe.tsx",
      "app/routes/utility/engagement-open.ts",
      "app/routes/utility/engagement-click.ts",
    ];
    for (const path of utility) {
      expect(readFileSync(path, "utf8"), path).toContain(
        '"no-store, no-cache, must-revalidate, private"',
      );
    }

    const existing = new Response("x", {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" },
    });
    expect(applyCachePolicy(request("/p/tok"), existing).headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate, private",
    );
  });

  it("the files routes' committed values are unchanged", () => {
    const expected: Record<string, string> = {
      "app/routes/files/feed.ts": "public, max-age=3600, stale-while-revalidate=86400",
      "app/routes/files/llms.ts": "public, max-age=86400, stale-while-revalidate=86400",
      "app/routes/files/llms-full.ts": "public, max-age=86400, stale-while-revalidate=86400",
      "app/routes/files/robots.ts": "public, max-age=86400",
      "app/routes/files/sitemap.ts": "public, max-age=3600",
    };
    for (const [path, value] of Object.entries(expected)) {
      expect(readFileSync(path, "utf8"), path).toContain(value);
    }
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

  it("A PRIVATE route that sets its own Cache-Control keeps it AND gains nothing", () => {
    const existing = new Response("x", {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" },
    });
    const applied = applyCachePolicy(request("/p/tok"), existing);
    expect(applied.headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate, private",
    );
    expect(applied.headers.get("Vary")).toBeNull();
  });

  it("THE THEME-ONLY CASE stays public AND carries Vary", () => {
    const applied = applyCachePolicy(request("/", "theme=dark"), new Response("x"));
    expect(applied.headers.get("Cache-Control")).toBe(CACHE_DIRECTIVES.marketing);
    expect(applied.headers.get("Vary")).toBe("Cookie");
  });

  it("a signed-in public-class request is private and still carries Vary", () => {
    const applied = applyCachePolicy(request("/", PROD_COOKIE), new Response("x"));
    expect(applied.headers.get("Cache-Control")).toBe(PRIVATE_DIRECTIVE);
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
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(limited, nonce))");
    expect(source).toContain("applyCachePolicy(request, applySecurityHeaders(response, nonce))");
  });

  it("NO ROUTE DUPLICATES THE POLICY: the Cache-Control sites are exactly the ones folded in", () => {
    // DERIVED FROM THE TREE, not from a list in this file, and it fails in both
    // directions: a route that starts setting its own header opts itself out of
    // the policy silently, and a folded-in route that stops setting one changes
    // its behaviour silently.
    const found = execSync('git grep -l Cache-Control -- app/routes || true', {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(found).toEqual(
      [
        "app/routes/files/feed.ts",
        "app/routes/files/llms-full.ts",
        "app/routes/files/llms.ts",
        "app/routes/files/robots.ts",
        "app/routes/files/sitemap.ts",
        "app/routes/utility/card-update.tsx",
        "app/routes/utility/engagement-click.ts",
        // The honeypot (377(4)). Same no-store header as its siblings, for the
        // same reason and one more: a cached response would let a scanner's
        // fetch be served without ever reaching the recorder, so the trap would
        // spring once and never again.
        "app/routes/utility/engagement-honeypot.ts",
        "app/routes/utility/engagement-open.ts",
        "app/routes/utility/unsubscribe.tsx",
      ].sort(),
    );
  });
});
