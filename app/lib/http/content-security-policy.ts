// THE CONTENT-SECURITY-POLICY AND THE ONE PLACE THE HEADERS ARE APPLIED. The
// header set comes from site-runtime through header-set.ts and the policy from
// site-runtime's builder; what stays here is Foxhound's own list of what it
// loads and the Worker-side merge. The single call site is workers/app.ts's
// fetch handler, which makes the nonce (site-runtime's generateNonce) before
// the route runs.
//
//  - script-src carries a per-request nonce: React Router's <Scripts> and
//    <ScrollRestoration> emit real inline module scripts, which a policy with
//    no nonce blocks (and with them every client handler). JSON-LD blocks are
//    data and need none. Violations go to the report sink (/csp-report);
//    a CDP console capture does not show them.
//  - A public page from the Renderer entrypoint is stored at the edge
//    (site-runtime ./edge-cache) with the nonce it was rendered with, and the
//    gateway gives every reader a fresh one (site-runtime's renewNonce), on
//    the policy and on only the elements that carried the stored value, so no
//    two readers share a nonce and no injected script gains one.
//  - style-src has no 'unsafe-inline' for elements. Inline style={{}} attributes (charts.tsx,
//    fade-up.tsx, reading-progress-bar.tsx, faq-accordion.tsx and others) are
//    allowed by style-src-attr 'unsafe-inline', which runs no code. The two
//    inline <style> elements are trusted by hash (inline-styles.ts).
//  - form-action is 'self' plus Stripe Checkout and Connect. Checkout starts through a
//    React Router <Form method="post"> (DemoGuardedForm on
//    app/routes/app/billing/index.tsx, the card-update and win-back forms on
//    app/routes/utility/card-update.tsx) whose action returns
//    `redirect(session.url)`. Once hydrated, that submission is a fetch and the
//    router then navigates to Stripe, which form-action does not govern; a
//    native POST made before hydration (or with no JS) is a form navigation, and
//    Chromium applies form-action to its redirect, so 'self' alone refused it.
//    The Stripe origins are the builder's `formTargets`; pass the same list to
//    site-runtime's checkSecurityHeaders, which accepts them after 'self'.
//  - No external origins except Cloudflare's own: Turnstile
//    (challenges.cloudflare.com, script and frame) and the Web Analytics beacon,
//    which Cloudflare injects at the edge and which public sites allow (Dustin's
//    ruling, 2026-10-03). site-runtime names the beacon by its path prefix
//    (static.cloudflareinsights.com/beacon.min.js and .../beacon.min.js/). The beacon
//    reports to this origin's /cdn-cgi/rum, so connect-src stays 'self'. Fonts
//    are self-hosted and preloaded from root.tsx; no <img src="https://...">
//    beyond same-origin; no js.stripe.com / Stripe Elements usage anywhere in
//    the client tree.
//  - frame-src is Turnstile (sources.frame; the builder adds 'self').

import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";
import {
  buildContentSecurityPolicy,
  buildStagedPolicy,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  reportingEndpoints,
} from "@dustinedwards/site-runtime/csp";
import { TURNSTILE_ORIGIN } from "@dustinedwards/site-runtime/turnstile";

import { SECURITY_HEADERS } from "./header-set";
import { INLINE_STYLE_HASHES } from "./inline-styles";

// Reports go to the family's path and group (site-runtime's CSP_REPORT_PATH, /csp-report, and CSP_REPORT_GROUP),
// the builder's defaults and what the check expects.
export { CSP_REPORT_PATH };

// BUILT AND VALIDATED ONCE, at module load, with a placeholder nonce; only the
// nonce is swapped per request. Every check the builder makes (sources, hashes,
// the report sink, the nonce's own shape) has run on this exact policy, and
// test/csp-memo.test.ts proves the per-request string equals the builder's own
// output for that nonce. The placeholder is a valid nonce the builder accepts
// and generateNonce cannot produce (24 base64 characters always end in "==",
// this one has none), so the substitution can only hit the nonce sources.
const NONCE_PLACEHOLDER = "Rk9YSE9VTkROT05DRVBMQUNFSE9MREVS";
const SITE = {
  sources: {
    script: [TURNSTILE_ORIGIN],
    frame: [TURNSTILE_ORIGIN],
    img: ["data:"],
  },
  styleHashes: INLINE_STYLE_HASHES,
  styleAttributesInline: true,
  cloudflareWebAnalytics: true,
  // Stripe Checkout, and Connect OAuth, which /connect's POST redirects to.
  formTargets: ["https://checkout.stripe.com", "https://connect.stripe.com"],
} as const;
const POLICY = buildContentSecurityPolicy({ ...SITE, nonce: NONCE_PLACEHOLDER });
const POLICY_PARTS = POLICY.value.split(`'nonce-${NONCE_PLACEHOLDER}'`);
// What the registry entry stages (Trusted Types, default-src 'none'), Report-Only beside the enforced policy until the
// reports are quiet; renewNonce renews its nonce with the other's.
const STAGED = buildStagedPolicy({ ...SITE, nonce: NONCE_PLACEHOLDER }, { trustedTypes: true, denyUnlisted: true });
const STAGED_PARTS = STAGED.value.split(`'nonce-${NONCE_PLACEHOLDER}'`);

/** The policy and its Report-Only stage for one response, each carrying that request's nonce. */
function contentSecurityPolicies(nonce: string) {
  return [
    { name: POLICY.name, value: POLICY_PARTS.join(`'nonce-${nonce}'`) },
    { name: STAGED.name, value: STAGED_PARTS.join(`'nonce-${nonce}'`) },
  ];
}

/**
 * Apply the security header set to a response, merging onto (never
 * overwriting) whatever headers the route already set (applyHeaderSet with
 * overwrite: false, site-runtime's "foxhound merge"). Builds a fresh Response
 * rather than mutating response.headers in place, since a Response returned
 * from certain sources (Response.redirect, the Cache API) has an immutable
 * Headers guard; passing response.body through directly preserves streaming
 * SSR output instead of buffering it. `nonce` must be the SAME value passed
 * to root.tsx's <Scripts>/<ScrollRestoration> for this request, or the
 * browser will reject the very scripts the nonce exists to allow. `origin` is
 * the request's own: the Reporting API ignores a relative endpoint, so the
 * report-to group needs this origin's absolute URL (until site-runtime v0.12.0
 * the header named the bare path and no report-to report was ever sent).
 */
export function applySecurityHeaders(response: Response, nonce: string, origin: string): Response {
  return withHeaders(response, contentSecurityPolicies(nonce), origin);
}

function withHeaders(response: Response, policies: { name: string; value: string }[], origin: string): Response {
  const headers = new Headers(response.headers);
  applyHeaderSet(headers, SECURITY_HEADERS, { overwrite: false });
  if (!headers.has("Content-Security-Policy")) {
    for (const { name, value } of policies) headers.set(name, value);
    try {
      headers.set("Reporting-Endpoints", reportingEndpoints(CSP_REPORT_GROUP, new URL(CSP_REPORT_PATH, origin)));
    } catch {
      // A plain-http origin, which reportingEndpoints refuses and a browser
      // would ignore: the page is still served, with report-uri as its sink.
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
