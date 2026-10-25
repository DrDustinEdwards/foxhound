import { securityTxtResponse } from "@dustinedwards/site-runtime/security-txt";

import { DAY_MS } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { SUPPORT_EMAIL, siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/security-txt";

// /.well-known/security.txt, RFC 9116 (377 item 11), from site-runtime: it tells somebody who has found a vulnerability
// where to send it, before they decide a public post is the only channel.
//
// EXPIRES IS COMPUTED AT REQUEST TIME, 335 days out: under the year RFC 9116 recommends, with a month of margin, so a
// Worker deployed once and left alone never serves a date in the past.
//
// THE CACHE POLICY IS NOT SET HERE: the path is listed in cache-policy's FILES_EXACT, and the one choke point in
// workers/app.ts sets it, so securityTxtResponse's own default is removed rather than left to compete.
const EXPIRES_DAYS = 335;

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const response = securityTxtResponse({
    origin: url,
    contact: SUPPORT_EMAIL,
    expires: new Date(Date.now() + EXPIRES_DAYS * DAY_MS),
    policy: `${url}/security`,
  });
  response.headers.delete("Cache-Control");
  return response;
}
