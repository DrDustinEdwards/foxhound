import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { readThemeCookie } from "capsomer/theme-server";

import { INDEXNOW_KEY_PATH } from "~/lib/seo/indexnow-key";
import { resolveThemePreference, THEME_COOKIE } from "~/lib/theme";

// THE RESPONSE CACHE POLICY (345 binding 4; the edge page cache since
// site-runtime 0.33.0's ./edge-cache).
//
// This decides `Cache-Control` from the route class, whether the request
// carries a session cookie, and which entrypoint rendered it. It is applied in
// ONE place, workers/app.ts, beside applySecurityHeaders, which is already the
// single choke point every response passes through. React Router 8's `headers`
// export is PER ROUTE, so expressing this there would mean the same directive
// copied into ~60 route modules and a new route defaulting to nothing; the
// fetch entry needs no framework feature and cannot be forgotten by a new route.
//
// HOW A PAGE IS STORED. The Worker's default export is a gateway with the
// Workers cache disabled, so it runs on EVERY request, hits included. It sends
// a request to the cacheable Renderer entrypoint only when edgeCacheable()
// below says so: a GET of a public page whose only cookie, if any, is
// the theme. Everything else, and above all every request carrying a session
// cookie, is rendered by the gateway itself and stored nowhere. That is what
// the first enable (session 53) lacked: the Worker did not run on a hit, so
// nothing it computed could stop a signed-in request being served a stored
// page. Now the gateway decides before the cache is consulted.
//
// WHY THE COOKIE CHECK IS STILL LOAD BEARING: the marketing layout renders the
// signed-in account switcher on the same URLs anonymous visitors fetch
// (app/layouts/marketing.tsx), so a signed-in render must never reach the
// Renderer. CLAUDE.md hard rule 9: one signed-in cache HIT means turn page
// caching off.
//
// And responses with NO Cache-Control are eligible for heuristic freshness under
// RFC 9111, so "we set no header" is not the same as "it will not be cached".
// Every response leaves here with an explicit directive.

/** Anything not matched below is PRIVATE. The default is the safe one. */
export type CacheClass = "marketing" | "docs" | "blog" | "files" | "private";

/*
 * The classes whose pages the edge stores: marketing, docs and blog (site-runtime ./edge-cache). Every
 * one is rendered the same for every anonymous reader. Stored a day and served
 * stale a week while it re-renders (publicPageHeaders), tagged "pages". That is
 * safe because every deploy starts cold (`cross_version_cache` stays false, so
 * the Worker version is in the key) and every Carrel write and applied blog
 * schedule purges the tag (workers/app.ts, app/lib/carrel/handler.server.ts).
 * The browser keeps nothing (max-age=0), because a purge cannot reach it.
 */

/**
 * The directive for a files route that sets none of its own (the card route).
 * Its output is a pure function of the URL and changes only on deploy.
 */
export const CACHE_DIRECTIVES: Record<"files", string> = {
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
const SESSION_COOKIE_FAMILY = "better-auth.";

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
  "/security",
  "/products",
  "/compare",
  "/decline-codes",
  // The estimator and the demo's door. Their GETs read nothing per reader and
  // write nothing: the estimator's Turnstile-gated POST and the /demos/* entries
  // that set the demo cookie are other requests, which never reach the Renderer.
  "/audit",
  "/demos",
]);

/** Prefixes that are PUBLIC marketing, with their own index covered above. */
// "/product/" is Recova's product pages; "/products/" stays for the four
// old spoke addresses, which now answer a 301 to them.
const MARKETING_PREFIXES = ["/product/", "/products/", "/compare/", "/decline-codes/"];

/** Files routes. `/og/` and `/og` are included: the card route sets no
 *  Cache-Control of its own today and its output is a pure function of the
 *  URL (path params, or Recova's query form on `/og`). */
const FILES_EXACT = new Set([
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/llms-full.txt",
  "/feed.rss",
  // RFC 9116. A static text file whose only variable is the
  // request clock, so it caches exactly like the other files routes.
  "/.well-known/security.txt",
  // The IndexNow key file. Its body is a constant that only
  // a deploy changes, so it caches like the other files routes.
  INDEXNOW_KEY_PATH,
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
  // The blog's media library files set their own five-minute directive
  // (app/routes/files/media.ts); listed so they get Vary: Cookie like any file.
  if (FILES_EXACT.has(path) || path === "/og" || path.startsWith("/og/") || path.startsWith("/media/")) return "files";
  return "private";
}

/**
 * The directive for a response that set none of its own. `edge` is true only in
 * the Renderer, the one entrypoint whose responses are stored.
 *
 * A page class is shared ONLY when the Renderer rendered it for a request with
 * no session cookie. Rendered by the gateway (a request with a cookie other
 * than the theme, or a write), it is `private, no-store`: that render carries a
 * per-request nonce and possibly the reader's account switcher.
 */
export function resolveCacheControl(request: Request, edge = false): string {
  const cacheClass = classifyPath(new URL(request.url).pathname);
  if (cacheClass === "private") return PRIVATE_DIRECTIVE;
  if (cacheClass === "files") return CACHE_DIRECTIVES.files;
  if (!edge || hasSessionCookie(request)) return PRIVATE_DIRECTIVE;
  return publicPageHeaders()["Cache-Control"];
}

/**
 * Should the gateway send this request through the cacheable Renderer?
 *
 * Only a GET of a public page or files route (a HEAD is answered with an
 * empty body by app/entry.server.tsx, which must never be stored), never /media (its own
 * route keeps each size in caches.default), and only when every cookie the
 * request carries is the theme cookie. A session cookie, the demo cookie, the
 * audit cookie, an OAuth state cookie or anything else sends it to the gateway's
 * own render, which nothing stores. Fails closed: an unknown cookie is a miss,
 * never a leak.
 */
export function edgeCacheable(request: Request): boolean {
  if (request.method !== "GET") return false;
  const pathname = new URL(request.url).pathname;
  const cacheClass = classifyPath(pathname);
  if (cacheClass === "private" || pathname.startsWith("/media/")) return false;
  return cookieNames(request).every((name) => name === THEME_COOKIE);
}

function cookieNames(request: Request): string[] {
  const header = request.headers.get("cookie");
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim().split("=")[0]?.trim() ?? "")
    .filter(Boolean);
}

/**
 * The request the Renderer sees, and the theme its cache key holds. The theme
 * is the one cookie a public page reads (<html data-theme> and the toggle), so
 * it is resolved here and handed on as the only cookie; the gateway adds it to
 * site-runtime's cacheKey as a dimension: one stored copy per theme, and a
 * stored dark page can never answer a light reader.
 */
export function edgeRequest(request: Request): { request: Request; theme: string } {
  const theme = resolveThemePreference({ accountTheme: null, cookieTheme: readThemeCookie(request, THEME_COOKIE) });
  const forwarded = new Request(request);
  forwarded.headers.set("Cookie", `${THEME_COOKIE}=${theme}`);
  return { request: forwarded, theme };
}

/**
 * `Vary: Cookie` on every PUBLIC-class response.
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
 * SINCE THE GATEWAY, VARY IS THE SECOND LOCK, NOT THE FIRST. The gateway now
 * runs on every request and never sends a session cookie to the Renderer, and
 * the Renderer only ever sees `fh_theme=<theme>`, which is also in its key. The
 * header stays (CLAUDE.md hard rule 9) so that any cache that does read it,
 * the Workers cache or one between the reader and the edge, keys a cookie-less
 * copy apart from a signed-in one.
 */
const VARY_HEADER_VALUE = "Cookie";

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
 * KEEP CLOUDFLARE WEB ANALYTICS OFF SIGNED-IN AND TOKEN PAGES
 * (Dustin's ruling 2026-10-04: count public pages only).
 *
 * Automatic beacon injection is zone-wide and path rules need the Pro plan, so
 * the exclusion has to come from the Worker. Cloudflare's Web Analytics FAQ says
 * a response whose Cache-Control includes `no-transform` is not modified by the
 * proxy, so no beacon is injected. Side effect: Cloudflare also skips
 * compression for such a response, so this is applied to HTML only, never to
 * assets, resource routes or marketing pages.
 *
 * The prefixes mirror the `app-shell` layout in app/routes.ts (admin included,
 * it lives inside that layout) plus the four bearer-token pages, whose paths
 * carry ids and tokens that must not reach a third-party analytics store.
 * test/cache-policy.test.ts fails if a top-level app-shell route is missing.
 */
export const NO_TRANSFORM_PREFIXES = [
  "/console",
  "/billing",
  // Every product page sits below its prefix since J09 (Recova's
  // /recovery/dashboard and the like); there is no page at the bare prefix.
  "/recovery/",
  "/disputes/",
  "/intelligence/",
  "/settings",
  "/audit/dashboard",
  "/audit/runs/",
  "/audit/results/",
  "/help",
  "/welcome",
  "/admin",
  "/p/",
  "/u/",
  "/invite/",
  // Where the emailed sign-in link lands, carrying a signed-in session.
  "/passkey",
  // The OAuth consent page: its query carries a client's id and state.
  "/oauth/",
];

function needsNoTransform(pathname: string, response: Response): boolean {
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().includes("text/html")) return false;
  return NO_TRANSFORM_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

/** Merge into the one Cache-Control value; never a second header. */
function addNoTransform(headers: Headers): void {
  const existing = headers.get("Cache-Control") ?? "";
  const parts = existing.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === "no-transform")) return;
  headers.set("Cache-Control", [...parts, "no-transform"].join(", "));
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
 *
 * `edge` is true only in the Renderer (workers/app.ts), where a page class
 * rendered for an anonymous reader gets site-runtime's publicPageHeaders: the
 * shared directive, the edge lifetime and the "pages" purge tag.
 */
export function applyCachePolicy(request: Request, response: Response, edge = false): Response {
  const pathname = new URL(request.url).pathname;
  const isPublicClass = classifyPath(pathname) !== "private";
  const wantsNoTransform = needsNoTransform(pathname, response);
  if (response.headers.has("Cache-Control") && !isPublicClass && !wantsNoTransform) return response;

  const headers = new Headers(response.headers);
  if (!headers.has("Cache-Control")) {
    const directive = resolveCacheControl(request, edge);
    // A shared page takes the edge header and the purge tag with it. One that
    // sets a cookie is never shared, whatever its class.
    const shared = publicPageHeaders();
    if (directive === shared["Cache-Control"] && !headers.has("Set-Cookie")) {
      for (const [name, value] of Object.entries(shared)) headers.set(name, value);
    } else {
      headers.set("Cache-Control", directive === shared["Cache-Control"] ? PRIVATE_DIRECTIVE : directive);
    }
  }
  if (wantsNoTransform) addNoTransform(headers);
  if (isPublicClass) {
    appendVary(headers, VARY_HEADER_VALUE);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
