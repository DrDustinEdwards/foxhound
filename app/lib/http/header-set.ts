// THE SECURITY HEADER SET, from site-runtime (RULES.md 4.2; Q4, Dustin "yes",
// 2026-10-14; J22 row F16). The values are OWASP Secure Headers Project's own,
// read by site-runtime; this file holds only where Foxhound must differ, each
// with its reason, and buildSecurityHeaders refuses an override with no reason
// or one that restates the standard, so the list below stays the list of real
// deviations.
//
// Two places apply it. The Worker (content-security-policy.ts,
// applySecurityHeaders) stamps it on every response the Worker makes, redirects
// and errors included. public/_headers carries it for static assets, which
// Cloudflare's asset server answers WITHOUT running the Worker (run_worker_first
// stays off, RULES.md 4.2); that file is GENERATED from this set by
// scripts/gen-headers.mjs and test/static-headers.test.ts fails on drift.
//
// This module imports only the package, never a `~/` path or a relative file,
// so scripts/gen-headers.mjs can load it with Node's type stripping.
//
// RULES.md 4.1 is the floor: nothing here is weaker than Foxhound's pre-J22 set
// (HSTS one year, X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin,
// camera/microphone/geolocation/payment denied) or Recova's next.config.ts
// (blob 8cf9b0c7). test/security-headers.test.ts grades the applied headers
// against both.
//
// What the standard brings over the pre-J22 set, taken as is: HSTS two years
// (no preload, as before: add it only once the foxhoundapp.com apex is verified
// HTTPS-only, TASK-foxhound-security-headers.md), Cross-Origin-Opener-Policy
// same-origin (Stripe Checkout and Connect are top-level redirects, Turnstile is
// an iframe, so nothing relies on a cross-origin opener), Cross-Origin-Resource-
// Policy same-origin as the default (the images other origins embed are opened
// up below, EMBEDDABLE_RESOURCE_HEADERS; a webmail client that loads the email
// open pixel directly still makes the request the open is recorded from),
// X-DNS-Prefetch-Control off (Recova sent "on"), X-Permitted-Cross-Domain-
// Policies none, and OWASP's full Permissions-Policy list.

import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import {
  buildSecurityHeaders,
  headersFile,
  PASSKEY_OVERRIDES,
  type HeaderOverride,
} from "@dustinedwards/site-runtime/headers";

// OWASP's Permissions-Policy with passkey sign-in allowed for this origin
// (site-runtime's PASSKEY_OVERRIDES), the starting point for clipboard-write below.
const PASSKEY_PERMISSIONS_POLICY = PASSKEY_OVERRIDES["Permissions-Policy"]?.value ?? "";

/**
 * A Permissions-Policy with clipboard-write set to (self), from a parsed list,
 * not a string replace: if OWASP's text changes spelling (spacing, order) or
 * drops the feature, a replace would silently do nothing and
 * buildSecurityHeaders would throw "says what the standard already says" when
 * the Worker starts. Parsing sets it in every case; the test that OWASP still
 * lists the feature fails in CI instead.
 */
export function withClipboardWriteSelf(policy: string): string {
  const directives = policy
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "");
  const others = directives.map((directive) =>
    directive.split("=")[0]?.trim() === "clipboard-write" ? "clipboard-write=(self)" : directive,
  );
  if (!others.includes("clipboard-write=(self)")) others.push("clipboard-write=(self)");
  return others.join(", ");
}

export const SECURITY_HEADER_OVERRIDES: Readonly<Record<string, HeaderOverride>> = {
  "Referrer-Policy": {
    value: "strict-origin-when-cross-origin",
    reason:
      "OWASP's no-referrer also makes browsers send `Origin: null` on same-origin form and fetch POSTs (Fetch spec, request origin serialization), and Better Auth refuses those with MISSING_OR_NULL_ORIGIN, so every signed-in auth POST would fail; /api/account/switch also returns the merchant to the page they were on from the same-origin Referer. This is Foxhound's pre-J22 value and Recova's (next.config.ts), so nothing is weakened.",
  },
  "Permissions-Policy": {
    value: withClipboardWriteSelf(PASSKEY_PERMISSIONS_POLICY),
    reason:
      "OWASP denies clipboard-write outright, which blocks navigator.clipboard.writeText in Chromium and kills two controls Recova has: the blog Share row's Copy link and the payment detail page's copy-email button. It also denies publickey-credentials-get, which refuses every passkey sign-in (site-runtime's PASSKEY_OVERRIDES). Both are allowed for this origin only; every other OWASP feature stays denied, camera, microphone, geolocation and payment included.",
  },
};

// The standard set with Foxhound's overrides, plus Prelum's TDMRep header,
// which reserves training rights as /ai.txt says.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...buildSecurityHeaders({ overrides: SECURITY_HEADER_OVERRIDES }),
  ...TDM_RESERVATION_HEADERS,
});

const STATIC_HEADERS_PREAMBLE = `GENERATED by scripts/gen-headers.mjs from app/lib/http/header-set.ts. Do not
edit: change the set there and run \`npm run gen:headers\`.
test/static-headers.test.ts fails if this file and the generator disagree.

Static-asset responses are served by Cloudflare's asset server WITHOUT
invoking the Worker (wrangler.jsonc's assets block sets no run_worker_first),
so applySecurityHeaders in workers/app.ts never runs for them. Measured live
before this file existed: an HTML page and /robots.txt carried 6 of 6 security
headers while every hashed asset and /favicon.svg carried 0 of 6.

Legacy applied its header set to \`source: '/(.*)'\` in next.config.ts, which on
Vercel covered static files too, so this was a legacy-present gap rather than a
preference (ruling 106). The block below is the same set the Worker applies,
site-runtime's OWASP standard with Foxhound's overrides (RULES.md 4.2).

Content-Security-Policy is deliberately NOT here. Foxhound's CSP carries a
per-request nonce and cannot be expressed as a static header; ruling 93 protects
that strength as class 2(a) and it is never traded away for uniformity.

Images other origins embed (the RSS channel image, the favicons) send
Cross-Origin-Resource-Policy: cross-origin; each rule detaches the /* value
with "!", since Cloudflare JOINS a header that two matching rules set.`;

// IMAGES MEANT TO BE EMBEDDED BY OTHER ORIGINS get Cross-Origin-Resource-Policy:
// cross-origin; everything else keeps the standard's same-origin. Recova sent no
// CORP at all, so these were embeddable there. /favicon.png is the RSS channel
// image (feed.ts, F5), which feed readers and other sites load
// cross-origin, and the favicons are what other sites show beside a Foxhound
// link. The og cards (/og/*) are Worker responses, so the og route sets the
// same header itself and the Worker's merge keeps it.
export const EMBEDDABLE_RESOURCE_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Resource-Policy": "cross-origin",
};
export const EMBEDDABLE_STATIC_PATHS: readonly string[] = ["/favicon.png", "/favicon.svg"];

/** The whole of public/_headers, as scripts/gen-headers.mjs writes it (site-runtime's headersFile). */
export function renderStaticHeadersFile(): string {
  return headersFile(SECURITY_HEADERS, {
    comment: STATIC_HEADERS_PREAMBLE,
    paths: {
      ...Object.fromEntries(EMBEDDABLE_STATIC_PATHS.map((path) => [path, EMBEDDABLE_RESOURCE_HEADERS])),
      "/assets/*": { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  });
}
