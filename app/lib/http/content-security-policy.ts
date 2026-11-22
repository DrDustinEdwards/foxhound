// Foxhound's Content-Security-Policy source list; the header set, merge, Report-Only stage and nonce come from
// site-runtime (header-set.ts, pageSecurity, workers/app.ts).
//  - script-src carries a per-request nonce: React Router's inline module scripts need it. JSON-LD needs none.
//    A stored edge page gets a fresh nonce per reader (renewNonce), so no two readers share one.
//  - style-src has no 'unsafe-inline' for elements; style="" attributes are allowed (style-src-attr), and the
//    two inline <style> elements are trusted by hash (inline-styles.ts).
//  - form-action is 'self' plus Stripe Checkout and Connect: a native POST before hydration (or with no JS)
//    that redirects to Stripe is a form navigation, which Chromium checks against form-action. Pass the same
//    `formTargets` to site-runtime's checkSecurityHeaders.
//  - No external origins except Cloudflare's own: Turnstile (script and frame) and the Web Analytics beacon
//    (reports to this origin's /cdn-cgi/rum, so connect-src stays 'self'). Fonts are self-hosted; no
//    js.stripe.com or Stripe Elements anywhere in the client.
//  - frame-src is Turnstile (the builder adds 'self').

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
  // The post players a page may frame, loaded only on the reader's click; `embeds` delegates their features in Permissions-Policy.
  embeds: true,
  formTargets: ["https://checkout.stripe.com", "https://connect.stripe.com"],
  // Enforced: a string never reaches an injection sink, and only the shared policy names exist.
  trustedTypes: TRUSTED_TYPES_NAMES,
} as const;

/** The security set on any response, the route's own headers kept, with the policy carrying the page's nonce
 *  and, beside it, the Report-Only policy the registry entry stages. A stored page gets a fresh nonce per reader. */
export const { withSecurityHeaders } = pageSecurity({
  set: SECURITY_HEADERS,
  policy: ({ nonce }) => ({ ...SITE, ...(nonce ? { nonce } : {}) }),
  staged: { denyUnlisted: true },
  renew: true,
});
