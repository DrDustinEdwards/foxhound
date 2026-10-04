// Security response headers applied to every response at the Worker boundary
// (audit finding H-1, foxhound-audit-security.md: the site shipped zero
// security headers). A pure function so the header set is unit-testable
// without the Workers runtime or the RR virtual server-build module; the
// single call site is workers/app.ts's fetch handler.
//
// CSP verified against the actual tree, not assumed (TASK-foxhound-security-headers.md,
// corrected by TASK-foxhound-csp-nonce-hydration.md):
//  - script-src carries a per-request nonce (see generateNonce below). The
//    original no-nonce policy was wrong: it reasoned that the only inline
//    <script> blocks in the app are non-executable type="application/ld+json"
//    JSON-LD (still true, still exempt, still no nonce needed on those), but
//    missed that React Router 8's own <Scripts>/<ScrollRestoration> emit
//    REAL inline `<script type="module">` bootstrap/hydration code. Under
//    script-src 'self' with no nonce and no 'unsafe-inline', the browser
//    silently blocked every one of those, so window.__reactRouterContext
//    never got assigned and no client handler on the site ever ran (dead
//    theme toggle, dead FAQ accordions, dead ROI slider, stuck scroll-reveal
//    opacity:0 sections - foxhound-audit-parity.md Cluster A). CDP-based
//    console capture does NOT surface CSP violation entries, which is how
//    two prior sessions concluded "zero CSP violations" while this was live;
//    do not use automation console output to re-litigate this.
//  - style-src needs 'unsafe-inline': several components use inline
//    style={{}} (app/components/charts.tsx, fade-up.tsx,
//    reading-progress-bar.tsx, faq-accordion.tsx).
//  - form-action is 'self' only. Stripe Checkout is started with a
//    server-side `redirect(session.url)` (app/routes/utility/card-update.tsx,
//    app/routes/app/billing/index.tsx), never an HTML <form action> to
//    Stripe, so checkout.stripe.com does not belong in form-action (a CSP
//    form-action directive does not apply to Location-header redirects).
//  - No external origins except Cloudflare's own: Turnstile
//    (challenges.cloudflare.com) and the Web Analytics beacon
//    (static.cloudflareinsights.com), which Cloudflare injects at the edge and
//    which public sites allow (Dustin's ruling, 2026-10-03). The beacon reports
//    to this origin's /cdn-cgi/rum, so connect-src stays 'self'. Fonts are
//    self-hosted and preloaded from root.tsx; no <img src="https://..."> beyond
//    same-origin; no js.stripe.com / Stripe Elements usage anywhere in the
//    client tree.

/** A fresh per-request nonce: 16 cryptographically random bytes, base64
 *  (24 chars with padding, comfortably over the 22-char floor the CSP nonce
 *  test asserts). Must be called once per request in workers/app.ts, BEFORE
 *  the request handler runs, and the same value threaded to both the HTML
 *  (root.tsx's <Scripts>/<ScrollRestoration>) and this module's CSP header -
 *  a mismatch would make the browser reject the very scripts the nonce
 *  exists to allow. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildContentSecurityPolicy(nonce: string): string {
  return (
    "default-src 'self'; " +
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://static.cloudflareinsights.com; ` +
    "frame-src https://challenges.cloudflare.com; " +
    "frame-ancestors 'none'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "base-uri 'none'; " +
    "form-action 'self'; " +
    "object-src 'none'"
  );
}

// No `preload` yet on HSTS: add it in a follow-up once the foxhoundapp.com
// cutover is verified HTTPS-only at the apex (TASK-foxhound-security-headers.md).
// Content-Security-Policy is NOT in this static list: it is per-request
// (carries the nonce), built by buildContentSecurityPolicy and added in
// applySecurityHeaders below.
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
];

/**
 * Apply the security header set to a response, merging onto (never
 * overwriting) whatever headers the route already set. Builds a fresh
 * Response rather than mutating response.headers in place, since a Response
 * returned from certain sources (e.g. the Cache API) has an immutable
 * Headers guard; passing response.body through directly preserves streaming
 * SSR output instead of buffering it. `nonce` must be the SAME value passed
 * to root.tsx's <Scripts>/<ScrollRestoration> for this request, or the
 * browser will reject the very scripts the nonce exists to allow.
 */
export function applySecurityHeaders(response: Response, nonce: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
