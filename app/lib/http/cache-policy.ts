// THE RESPONSE CACHE POLICY (345 binding 4).
//
// This decides one header, `Cache-Control`, from two inputs: the route class and
// whether the request carries a session cookie. It is applied in ONE place, the
// Worker fetch entry, beside applySecurityHeaders, which is already the single
// choke point every response passes through. React Router 8's `headers` export
// is PER ROUTE, so expressing this there would mean the same directive copied
// into ~60 route modules and a new route defaulting to nothing; the fetch entry
// needs no framework feature and cannot be forgotten by a new route.
//
// WHY THE COOKIE CHECK IS LOAD BEARING, and it is the whole reason this module
// exists rather than a one-line wrangler change:
//
// Cloudflare's documented bypass conditions are a `Set-Cookie` header on the
// RESPONSE and an `Authorization` header on the REQUEST
// (developers.cloudflare.com/workers/cache/). A request `Cookie` header triggers
// nothing. Foxhound's marketing layout renders the signed-in account switcher on
// the same URLs anonymous visitors fetch (app/layouts/marketing.tsx), so without
// this a signed-in render of `/` could be stored and served to a stranger.
//
// And responses with NO Cache-Control are eligible for heuristic freshness under
// RFC 9111, so "we set no header" is not the same as "it will not be cached".
// Every response leaves here with an explicit directive.

/** Anything not matched below is PRIVATE. The default is the safe one. */
export type CacheClass = "marketing" | "docs" | "blog" | "files" | "private";

/**
 * The directive per class.
 *
 * marketing and docs are authored in the repo and change only on deploy, and
 * `cross_version_cache` defaults false so the Worker version is part of the
 * cache key and every deploy already resets it. 300 seconds bounds how long a
 * stale edge copy can outlive a rollback.
 *
 * BLOG IS DELIBERATELY SHORTER. It is the only public class whose content can
 * change WITHOUT a deploy: posts are edited from /admin/blog into D1, so there
 * is no version bump to clear the cache, and a long TTL would leave a published
 * edit invisible.
 */
export const CACHE_DIRECTIVES: Record<Exclude<CacheClass, "private">, string> = {
  marketing: "public, max-age=300, stale-while-revalidate=3600",
  docs: "public, max-age=300, stale-while-revalidate=3600",
  blog: "public, max-age=60, stale-while-revalidate=600",
  files: "public, max-age=86400, stale-while-revalidate=86400",
};

export const PRIVATE_DIRECTIVE = "private, no-store";

/**
 * Better Auth's cookie name is `${securePrefix}${cookiePrefix}.${name}`
 * (node_modules/better-auth/dist/cookies/index.mjs), and the secure prefix is
 * applied whenever the base URL is https. Foxhound overrides neither
 * `cookiePrefix` nor `useSecureCookies` (app/lib/auth/options.ts), so the name
 * is `better-auth.session_token` locally and
 * `__Secure-better-auth.session_token` in production.
 *
 * THE MATCH IS THE FAMILY, NOT AN EXACT NAME. An exact-name check written
 * against the local spelling would read every signed-in production request as
 * anonymous, which is exactly the leak this module prevents. Matching the
 * `better-auth.` family also covers `session_data` and `account_data` when the
 * cookie cache is on, and any cookie Better Auth adds later.
 */
export const SESSION_COOKIE_FAMILY = "better-auth.";

const COOKIE_NAME_PREFIXES = ["__Secure-", "__Host-"];

function stripCookiePrefix(name: string): string {
  for (const prefix of COOKIE_NAME_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/** Does this request carry a Better Auth session cookie? */
export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (!header) return false;
  return header
    .split(";")
    .map((pair) => stripCookiePrefix(pair.trim().split("=")[0] ?? ""))
    .some((name) => name.startsWith(SESSION_COOKIE_FAMILY));
}

/** Exact paths that are PUBLIC marketing. */
const MARKETING_EXACT = new Set([
  "/",
  "/pricing",
  "/features",
  "/about",
  "/privacy",
  "/terms",
  "/audit",
  "/products",
  "/compare",
  "/decline-codes",
  "/demos",
]);

/** Prefixes that are PUBLIC marketing, with their own index covered above. */
const MARKETING_PREFIXES = ["/products/", "/compare/", "/decline-codes/"];

/** Files routes. `/og/` is included: it sets no Cache-Control of its own today
 *  and its output is a pure function of the path params. */
const FILES_EXACT = new Set([
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/feed.rss",
  // RFC 9116 (377 item 11). A static text file whose only variable is the
  // request clock, so it caches exactly like the other files routes.
  "/.well-known/security.txt",
]);

/**
 * Classify a pathname.
 *
 * EVERYTHING UNMATCHED IS PRIVATE. A route added tomorrow is private until
 * someone deliberately lists it, which is the direction a mistake should fall.
 */
export function classifyPath(pathname: string): CacheClass {
  const path = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;

  if (MARKETING_EXACT.has(path)) return "marketing";
  if (MARKETING_PREFIXES.some((prefix) => path.startsWith(prefix))) return "marketing";
  if (path === "/docs" || path.startsWith("/docs/")) return "docs";
  if (path === "/blog" || path.startsWith("/blog/")) return "blog";
  if (FILES_EXACT.has(path) || path.startsWith("/og/")) return "files";
  return "private";
}

/**
 * The directive for this request.
 *
 * A PUBLIC-class route is public ONLY on a request with no session cookie. With
 * one, the render carries that user's account switcher and is per-user, so it
 * is `private, no-store` like any app page.
 */
export function resolveCacheControl(request: Request): string {
  const cacheClass = classifyPath(new URL(request.url).pathname);
  if (cacheClass === "private") return PRIVATE_DIRECTIVE;
  if (hasSessionCookie(request)) return PRIVATE_DIRECTIVE;
  return CACHE_DIRECTIVES[cacheClass];
}

/**
 * `Vary: Cookie` on every PUBLIC-class response (348).
 *
 * THIS IS WHAT THE CACHE-CONTROL POLICY ALONE COULD NOT DO, and session 53's
 * first attempt proved it: THE WORKER DOES NOT RUN ON A CACHE HIT
 * (developers.cloudflare.com/workers/cache/configuration/). The cache is
 * consulted BEFORE the Worker, so a directive computed inside the Worker
 * governs what is STORED and can say nothing about what is SERVED. A stored
 * anonymous render of `/` was returned to a signed-in request, three times, and
 * the enable was reverted.
 *
 * Vary moves the decision into the CACHE KEY, which is the only layer that runs
 * on a hit: Cloudflare "stores a separate cached variant per distinct
 * combination of the listed request header values", so a request carrying a
 * session cookie cannot match the variant stored for a request carrying none.
 *
 * THE COST, stated because it shapes the hit rate rather than being a footnote:
 * values are compared VERBATIM with no normalization, so every distinct Cookie
 * header is its own variant. A cookie-less visitor, which is most first-time
 * and crawler traffic, shares one variant; a visitor carrying `theme=dark` gets
 * a second; `theme=light` a third. That is fragmentation, not a leak, and the
 * variants are all the same anonymous body.
 */
export const VARY_HEADER_VALUE = "Cookie";

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }
  const parts = existing.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === value.toLowerCase())) return;
  headers.set("Vary", [...parts, value].join(", "));
}

/**
 * Apply the policy on the way out.
 *
 * A RESPONSE THAT ALREADY SET ITS OWN `Cache-Control` KEEPS IT. The files and
 * utility routes each set one deliberately and their values are already
 * correct; this folds them into one table rather than duplicating the decision
 * in two places. Everything else, which is every route that sets none today,
 * gets an explicit directive so nothing is left to heuristic freshness.
 *
 * VARY IS APPLIED BY CLASS, NOT BY WHICH DIRECTIVE WON. A public-class route
 * gets `Vary: Cookie` even when it set its own Cache-Control, because the
 * question Vary answers is "could this response differ by cookie", and the
 * answer for a public-class URL is yes whatever header the route chose. The
 * PRIVATE class never gets it: those responses are `no-store` and are never
 * stored, so there is no variant to key.
 *
 * Only GET and HEAD are cacheable at all, but the headers are set on every
 * method anyway: it costs nothing and it means a POST response can never be
 * stored by an intermediary either.
 */
export function applyCachePolicy(request: Request, response: Response): Response {
  const isPublicClass = classifyPath(new URL(request.url).pathname) !== "private";
  if (response.headers.has("Cache-Control") && !isPublicClass) return response;

  const headers = new Headers(response.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", resolveCacheControl(request));
  }
  if (isPublicClass) {
    appendVary(headers, VARY_HEADER_VALUE);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
