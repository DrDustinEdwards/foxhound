// THE SECURITY HEADER SET, from site-runtime (RULES.md 4.2; Q4, Dustin "yes",
// 2026-10-14; J22 row F16). The values are OWASP Secure Headers Project's own,
// read by site-runtime; where Foxhound must differ is its entry in the site
// registry, each deviation with its reason.
//
// Two places apply it. The Worker (content-security-policy.ts,
// applySecurityHeaders) stamps it on every response the Worker makes, redirects
// and errors included. public/_headers carries it for static assets, which
// Cloudflare's asset server answers WITHOUT running the Worker (run_worker_first
// stays off, RULES.md 4.2); every build writes that file from the same registry
// entry (site-runtime's site-runtime-headers bin, with the TDMRep header), so it
// cannot drift.
//
// RULES.md 4.1 is the floor: nothing here is weaker than Foxhound's pre-J22 set
// (HSTS one year, X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin,
// camera/microphone/geolocation/payment denied) or Recova's next.config.ts
// (blob 8cf9b0c7).
//
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { foxhound } from "@dustinedwards/site-runtime/sites";

// Foxhound's entry in site-runtime's site registry (./sites, `foxhound`)
// holds its deviations and their reasons: Referrer-Policy
// strict-origin-when-cross-origin (Better Auth refuses the `Origin: null` that
// no-referrer causes) and Permissions-Policy allowing passkeys and
// clipboard-write for this origin. Prelum's TDMRep header goes beside it,
// reserving training rights as /ai.txt says.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...buildSecurityHeaders({ site: foxhound }),
  ...TDM_RESERVATION_HEADERS,
});
