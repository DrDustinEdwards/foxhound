// Security response headers applied to every response at the Worker boundary
// (audit finding H-1, foxhound-audit-security.md: the site shipped zero
// security headers). A pure function so the header set is unit-testable
// without the Workers runtime or the RR virtual server-build module; the
// single call site is workers/app.ts's fetch handler.
//
// CSP verified against the actual tree, not assumed (TASK-foxhound-security-headers.md):
//  - script-src carries no 'unsafe-inline' and no nonce. The only inline
//    <script> blocks in the app are type="application/ld+json" JSON-LD
//    (11 marketing/blog routes); the CSP spec's "prepare a script" algorithm
//    never reaches the inline-script check for a non-executable script type,
//    so these are unaffected by a strict script-src regardless of policy.
//    No theme/hydration inline snippet exists (root.tsx sets data-theme
//    server-side from a loader, not an inline script).
//  - style-src needs 'unsafe-inline': several components use inline
//    style={{}} (app/components/charts.tsx, fade-up.tsx,
//    reading-progress-bar.tsx, faq-accordion.tsx).
//  - form-action is 'self' only. Stripe Checkout is started with a
//    server-side `redirect(session.url)` (app/routes/utility/card-update.tsx,
//    app/routes/app/billing/index.tsx), never an HTML <form action> to
//    Stripe, so checkout.stripe.com does not belong in form-action (a CSP
//    form-action directive does not apply to Location-header redirects).
//  - No external font/image/analytics origins: fonts are self-hosted and
//    preloaded from root.tsx; no <img src="https://..."> beyond same-origin;
//    no js.stripe.com / Stripe Elements usage anywhere in the client tree.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self' https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "frame-ancestors 'none'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'self'; " +
  "object-src 'none'";

// No `preload` yet on HSTS: add it in a follow-up once the foxhoundapp.com
// cutover is verified HTTPS-only at the apex (TASK-foxhound-security-headers.md).
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
];

/**
 * Apply the security header set to a response, merging onto (never
 * overwriting) whatever headers the route already set. Builds a fresh
 * Response rather than mutating response.headers in place, since a Response
 * returned from certain sources (e.g. the Cache API) has an immutable
 * Headers guard; passing response.body through directly preserves streaming
 * SSR output instead of buffering it.
 */
export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
