// Cloudflare Access in front of /admin. Access signs the person in and forwards
// the request with a signed JWT (the Cf-Access-Jwt-Assertion header, and the
// same token in the CF_Authorization cookie). site-runtime's check verifies the
// signature, issuer and audience; the email must also be on the ADMIN_EMAIL
// allowlist (a second check behind the Access policy).
//
// Config (secrets, typed in env.d.ts):
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   ACCESS_AUD          the Access application's Audience (AUD) tag
//   ADMIN_EMAIL         the allowlist
// An unset team domain or AUD means nobody is admin: it fails closed.
import { verifyAccessRequest } from "@dustinedwards/site-runtime/access";

import { isAdminEmail } from "./roles";

export interface AdminSession {
  email: string;
}

/**
 * The signed-in admin, or null. Never throws: a refused token, an unreachable
 * key endpoint, and an email off the allowlist all return null.
 */
export async function getAdminSession(env: Env, request: Request): Promise<AdminSession | null> {
  // Local development has no Access in front of it. An explicit opt-in in
  // .dev.vars that only applies to a localhost URL, so a stray copy of it in
  // production still does nothing. The first allowlisted email is the admin.
  if (env.ACCESS_DEV_BYPASS === "1" && new URL(request.url).hostname === "localhost") {
    const email = (env.ADMIN_EMAIL ?? "").split(",")[0]?.trim().toLowerCase();
    return email ? { email } : null;
  }

  try {
    const verdict = await verifyAccessRequest(request, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      cookie: true,
    });
    if (!verdict.ok) return null;
    const email = typeof verdict.claims.email === "string" ? verdict.claims.email.toLowerCase() : "";
    if (!isAdminEmail(env, email)) return null;
    return { email };
  } catch {
    return null;
  }
}
