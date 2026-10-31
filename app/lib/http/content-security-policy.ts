// THE CONTENT-SECURITY-POLICY AND THE ONE PLACE THE HEADERS ARE APPLIED
// (audit finding H-1, foxhound-audit-security.md: the site once shipped zero
// security headers). Since J22 (row F16; RULES.md 4.2; Q4) the header set comes
// from site-runtime through header-set.ts and the policy from site-runtime's
// builder; what stays here is Foxhound's own list of what it loads and the
// Worker-side merge. The single call site is workers/app.ts's fetch handler,
// which makes the nonce (site-runtime's generateNonce) before the route runs.
//
// CSP verified against the actual tree, not assumed (TASK-foxhound-security-headers.md,
// corrected by TASK-foxhound-csp-nonce-hydration.md):
//  - script-src carries a per-request nonce. The original no-nonce policy was
//    wrong: it reasoned that the only inline <script> blocks in the app are
//    non-executable type="application/ld+json" JSON-LD (still true, still
//    exempt, still no nonce needed on those), but missed that React Router 8's
//    own <Scripts>/<ScrollRestoration> emit REAL inline `<script type="module">`
//    bootstrap/hydration code. Under script-src 'self' with no nonce and no
//    'unsafe-inline', the browser silently blocked every one of those, so
//    window.__reactRouterContext never got assigned and no client handler on
//    the site ever ran (dead theme toggle, dead FAQ accordions, dead ROI
//    slider, stuck scroll-reveal opacity:0 sections - foxhound-audit-parity.md
//    Cluster A). CDP-based console capture does NOT surface CSP violation
//    entries, which is how two prior sessions concluded "zero CSP violations"
//    while this was live; do not use automation console output to re-litigate
//    this. Since J22 the policy also has a report sink (/api/csp-report), so a
//    blocked script is heard about.
//  - site-runtime's rule is a nonce only on a response that is never
//    shared-cached. Since the edge page cache (site-runtime ./edge-cache), a
//    public page rendered by the Renderer entrypoint IS stored and handed to
//    every reader. It is stored with the nonce it was rendered with, and the
//    gateway gives every reader a fresh one (site-runtime's renewNonce), on
//    the policy and on only the elements that carried the stored value, so no
//    two readers share a nonce and no injected script gains one.
//  - style-src has NO 'unsafe-inline' for elements since J22, which is stricter
//    than the pre-J22 policy. Inline style={{}} attributes (charts.tsx,
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
//    (static.cloudflareinsights.com/beacon.min.js and .../beacon.min.js/), which
//    is narrower than the bare host the pre-J22 policy allowed. The beacon
//    reports to this origin's /cdn-cgi/rum, so connect-src stays 'self'. Fonts
//    are self-hosted and preloaded from root.tsx; no <img src="https://...">
//    beyond same-origin; no js.stripe.com / Stripe Elements usage anywhere in
//    the client tree.
//  - frame-src is Turnstile (sources.frame; the builder adds 'self').

import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";
import { buildContentSecurityPolicy, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { TURNSTILE_ORIGIN } from "@dustinedwards/site-runtime/turnstile";

import { SECURITY_HEADERS } from "./header-set";
import { INLINE_STYLE_HASHES } from "./inline-styles";

/** Where browsers send violation reports: the path Recova used too. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The Reporting API group name, defined by the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp-endpoint";

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
  reportUri: CSP_REPORT_PATH,
  reportTo: CSP_REPORT_GROUP,
  // Stripe Checkout, and Connect OAuth, which /connect's POST redirects to.
  formTargets: ["https://checkout.stripe.com", "https://connect.stripe.com"],
} as const;
const POLICY = buildContentSecurityPolicy({ ...SITE, nonce: NONCE_PLACEHOLDER });
const POLICY_PARTS = POLICY.value.split(`'nonce-${NONCE_PLACEHOLDER}'`);

/** The policy for one response, carrying that request's nonce. */
function contentSecurityPolicy(nonce: string) {
  return { name: POLICY.name, value: POLICY_PARTS.join(`'nonce-${nonce}'`) };
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
  return withHeaders(response, contentSecurityPolicy(nonce), origin);
}

function withHeaders(response: Response, policy: { name: string; value: string }, origin: string): Response {
  const headers = new Headers(response.headers);
  applyHeaderSet(headers, SECURITY_HEADERS, { overwrite: false });
  if (!headers.has("Content-Security-Policy")) {
    headers.set(policy.name, policy.value);
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
