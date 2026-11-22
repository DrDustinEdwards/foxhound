// The security header set, from site-runtime (OWASP Secure Headers values); Foxhound's deviations live in its
// site-registry entry with reasons. Two places apply it: the Worker (content-security-policy.ts) on every
// response it makes, and public/_headers for static assets, which Cloudflare serves WITHOUT running the Worker
// (run_worker_first stays off); every build writes that file from the same registry entry, so it cannot drift.
//
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { foxhound } from "@dustinedwards/site-runtime/sites";

// Deviations in the registry entry: Referrer-Policy strict-origin-when-cross-origin (Better Auth refuses the
// `Origin: null` that no-referrer causes) and Permissions-Policy allowing passkeys and clipboard-write. Prelum's
// TDMRep header goes beside it, reserving training rights as /ai.txt says.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...buildSecurityHeaders({ site: foxhound }),
  ...TDM_RESERVATION_HEADERS,
});
