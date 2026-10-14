// Cloudflare Access in front of /admin, the same pattern as germomics and Carrel.
// Access signs the person in, then forwards the request with a signed JWT in the
// Cf-Access-Jwt-Assertion header (and the same token in the CF_Authorization
// cookie). The header's presence is never trusted: the signature is verified
// against the team's published keys with jose, the issuer must be the team
// domain, the audience must be this application's AUD tag, and the email must be
// on the ADMIN_EMAIL allowlist (a second check behind the Access policy).
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
//
// Config (secrets, typed in env.d.ts):
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   ACCESS_AUD          the Access application's Audience (AUD) tag
//   ADMIN_EMAIL         the allowlist, as before
// An unset team domain or AUD means nobody is admin: it fails closed.
import { createRemoteJWKSet, jwtVerify } from "jose";

import { isAdminEmail } from "./roles";

export interface AdminSession {
  email: string;
}

// One key set per team domain. jose caches and refetches keys itself; this only
// avoids rebuilding the fetcher on every request. It holds public keys, never
// request state.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(teamDomain: string) {
  let set = keySets.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, set);
  }
  return set;
}

export function accessAssertion(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie");
  const match = cookie?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * The signed-in admin, or null. Never throws: a missing, malformed, expired,
 * wrong-audience or wrong-issuer token, an unreachable key endpoint, and an
 * email off the allowlist all return null.
 */
export async function getAdminSession(env: Env, request: Request): Promise<AdminSession | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  const audience = env.ACCESS_AUD;

  // Local development has no Access in front of it. An explicit opt-in in
  // .dev.vars that only applies to a localhost URL, so a stray copy of it in
  // production still does nothing. The first allowlisted email is the admin.
  if (env.ACCESS_DEV_BYPASS === "1" && new URL(request.url).hostname === "localhost") {
    const email = (env.ADMIN_EMAIL ?? "").split(",")[0]?.trim().toLowerCase();
    return email ? { email } : null;
  }

  if (!teamDomain || !audience) return null;
  const token = accessAssertion(request);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, keySetFor(teamDomain), {
      issuer: teamDomain,
      audience,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!isAdminEmail(env, email)) return null;
    return { email };
  } catch {
    return null;
  }
}
