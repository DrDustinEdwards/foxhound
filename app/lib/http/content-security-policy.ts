// THE CONTENT-SECURITY-POLICY. The header set comes from site-runtime through
// header-set.ts, and the Worker glue (the merge, the Report-Only stage, the
// Reporting API endpoint) is site-runtime's pageSecurity; what stays here is
// Foxhound's own list of what it loads. site-runtime's shared Worker
// (workers/app.ts) applies it to every response and makes each render's nonce.
//
//  - script-src carries a per-request nonce: React Router's <Scripts> and
//    <ScrollRestoration> emit real inline module scripts, which a policy with
//    no nonce blocks (and with them every client handler). JSON-LD blocks are
//    data and need none. Violations go to the shared Worker's report sink (/csp-report);
//    a CDP console capture does not show them.
//  - A public page from the Renderer entrypoint is stored at the edge
//    (site-runtime ./edge-cache) with the nonce it was rendered with, and the
//    gateway gives every reader a fresh one (site-runtime's renewNonce), on
//    the policy and on only the elements that carried the stored value, so no
//    two readers share a nonce and no injected script gains one.
//  - style-src has no 'unsafe-inline' for elements. Inline style={{}} attributes (charts.tsx,
//    fade-up.tsx, reading-progress-bar.tsx and others) are
//    allowed by style-src-attr 'unsafe-inline', which runs no code. The two
//    inline <style> elements are trusted by hash (inline-styles.ts).
//  - form-action is 'self' plus Stripe Checkout and Connect. Checkout starts through a
//    React Router <Form method="post"> (ReadOnlyForm on
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

import { pageSecurity } from "@dustinedwards/site-runtime/page-headers";
import { TRUSTED_TYPES_NAMES } from "@dustinedwards/site-runtime/trusted-types";
import { TURNSTILE_ORIGIN } from "@dustinedwards/site-runtime/turnstile";

import { SECURITY_HEADERS } from "./header-set";
import { INLINE_STYLE_HASHES } from "./inline-styles";

const SITE = {
  sources: {
    script: [TURNSTILE_ORIGIN],
    frame: [TURNSTILE_ORIGIN],
    img: ["data:"],
  },
  styleHashes: INLINE_STYLE_HASHES,
  styleAttributesInline: true,
  cloudflareWebAnalytics: true,
  // The post players a page may frame (YouTube, Spotify and the rest of Dustin's list), loaded only on the reader's click;
  // the registry entry's `embeds` opt-in delegates their features in the Permissions-Policy.
  embeds: true,
  // Stripe Checkout, and Connect OAuth, which /connect's POST redirects to.
  formTargets: ["https://checkout.stripe.com", "https://connect.stripe.com"],
  // Enforced since site-runtime 0.132.0: a string never reaches an injection sink, and only the shared policy names exist.
  trustedTypes: TRUSTED_TYPES_NAMES,
} as const;

/**
 * The security set on any response, the route's own headers kept (overwrite: false), with the policy carrying the
 * nonce the page was rendered with, and beside it, Report-Only, what the registry entry stages (default-src 'none')
 * until the reports are quiet. A stored page gets a fresh nonce per reader (renew).
 */
export const { withSecurityHeaders } = pageSecurity({
  set: SECURITY_HEADERS,
  policy: ({ nonce }) => ({ ...SITE, ...(nonce ? { nonce } : {}) }),
  staged: { denyUnlisted: true },
  renew: true,
});
