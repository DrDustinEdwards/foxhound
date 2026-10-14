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
//    shared-cached. A Worker's own response is not stored by Cloudflare's edge
//    unless the Worker puts it in the Cache API, which Foxhound does not;
//    cache-policy.ts's `public, max-age=300` on marketing pages lets the
//    reader's own browser keep one page with its own nonce, which is the same
//    reader. A cache rule that stored HTML at the edge would break this.
//  - style-src has NO 'unsafe-inline' for elements since J22, which is stricter
//    than the pre-J22 policy. Inline style={{}} attributes (charts.tsx,
//    fade-up.tsx, reading-progress-bar.tsx, faq-accordion.tsx and others) are
//    allowed by style-src-attr 'unsafe-inline', which runs no code. The two
//    inline <style> elements are trusted by hash (inline-styles.ts).
//  - form-action is 'self' only. Stripe Checkout is started with a
//    server-side `redirect(session.url)` (app/routes/utility/card-update.tsx,
//    app/routes/app/billing/index.tsx), never an HTML <form action> to
//    Stripe, so checkout.stripe.com does not belong in form-action (a CSP
//    form-action directive does not apply to Location-header redirects).
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
//  - frame-src is written here, not through the builder's `sources.frame`,
//    because the builder always adds 'self' to frame-src and the pre-J22 policy
//    framed Turnstile ONLY. RULES.md 4.1: a new default never loosens what
//    Foxhound already had.

import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";
import { buildContentSecurityPolicy } from "@dustinedwards/site-runtime/csp";

import { SECURITY_HEADERS } from "./header-set";
import { INLINE_STYLE_HASHES } from "./inline-styles";

/** Where browsers send violation reports: the path Recova used too. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The Reporting API group name, defined by the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp-endpoint";

const TURNSTILE = "https://challenges.cloudflare.com";

/** The policy for one response, carrying that request's nonce. */
function contentSecurityPolicy(nonce: string) {
  return buildContentSecurityPolicy({
    sources: {
      script: [TURNSTILE],
      img: ["data:"],
    },
    nonce,
    styleHashes: INLINE_STYLE_HASHES,
    styleAttributesInline: true,
    cloudflareWebAnalytics: true,
    extraDirectives: [`frame-src ${TURNSTILE}`],
    reportUri: CSP_REPORT_PATH,
    reportTo: CSP_REPORT_GROUP,
  });
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
 * browser will reject the very scripts the nonce exists to allow.
 */
export function applySecurityHeaders(response: Response, nonce: string): Response {
  const headers = new Headers(response.headers);
  applyHeaderSet(headers, SECURITY_HEADERS, { overwrite: false });
  if (!headers.has("Content-Security-Policy")) {
    const policy = contentSecurityPolicy(nonce);
    headers.set(policy.name, policy.value);
    headers.set("Reporting-Endpoints", `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
