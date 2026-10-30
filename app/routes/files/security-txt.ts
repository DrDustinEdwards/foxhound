import { securityTxtResponse } from "@dustinedwards/site-runtime/security-txt";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/security-txt";

// /.well-known/security.txt, RFC 9116, from site-runtime: it tells somebody who has found a vulnerability
// where to send it, before they decide a public post is the only channel. The family's one security address (Dustin,
// 2026-10-25) and a fixed Expires, as on every family site: a date that renews itself would keep vouching for an
// address nobody has checked.
//
// THE CACHE POLICY IS NOT SET HERE: the path is listed in cache-policy's FILES_EXACT, and the one choke point in
// workers/app.ts sets it, so securityTxtResponse's own default is removed rather than left to compete.
export const SECURITY_CONTACT = "security@dustinedwards.info";
export const SECURITY_TXT_EXPIRES = "2027-09-28T00:00:00Z";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const response = securityTxtResponse({
    origin: url,
    contact: SECURITY_CONTACT,
    expires: SECURITY_TXT_EXPIRES,
    policy: `${url}/security`,
  });
  response.headers.delete("Cache-Control");
  return response;
}
