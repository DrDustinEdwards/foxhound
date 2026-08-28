import { cloudflareContext } from "~/lib/cloudflare-context";
import { SUPPORT_EMAIL, siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/security-txt";

// /.well-known/security.txt, RFC 9116 (377 item 11).
//
// WHAT IT IS FOR: it tells somebody who has found a vulnerability where to send
// it, before they decide that a public post is the only channel available. That
// is the whole value, and it is why the file ships ahead of the /security page
// it points at rather than waiting for it.
//
// EXPIRES IS THE FIELD THAT ROTS, and RFC 9116 section 2.5.5 makes it mandatory
// for exactly that reason: a contact address nobody has confirmed in three years
// is worse than none, because a finder trusts it and gets silence. The spec
// recommends less than a year out, so this is computed as one year minus a
// month from the build, and the plant fails BEFORE the served file expires
// rather than after, with a message naming what to change.
//
// COMPUTED AT REQUEST TIME, NOT BAKED AT BUILD. A Worker deployed once and left
// alone would otherwise serve an Expires that drifts into the past silently. It
// is derived from the request's own clock, so a file served today is always
// valid for the window below, and the guard that matters is the test that
// refuses to let the window itself grow past the spec's ceiling.

/** How far ahead `Expires` is set. Under a year, per RFC 9116's recommendation,
 *  with a month of margin so a slow deploy cadence cannot push a served file
 *  past the ceiling. */
export const SECURITY_TXT_EXPIRES_DAYS = 335;

/** The ceiling the plant enforces. A year and a day, because the spec says
 *  "less than a year" and a value AT one year is already outside it. */
export const SECURITY_TXT_MAX_EXPIRES_DAYS = 366;

/**
 * Build the file. Pure, so the plant can parse it without a request.
 *
 * FIELD ORDER IS THE SPEC'S OWN. Contact first because it is the point of the
 * file; Expires next because a reader needs to know whether to trust the rest;
 * then Policy and Canonical.
 *
 * CANONICAL POINTS AT ITSELF, which is what the field is for: it says which URL
 * is the authoritative copy, so a mirror of this file found elsewhere can be
 * recognised as a copy rather than a second, possibly forged, contact route.
 */
export function buildSecurityTxt(url: string, now: Date): string {
  const expires = new Date(now.getTime() + SECURITY_TXT_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: mailto:${SUPPORT_EMAIL}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `Policy: ${url}/security`,
    `Canonical: ${url}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "",
  ].join("\n");
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return new Response(buildSecurityTxt(siteUrl(env), new Date()), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
