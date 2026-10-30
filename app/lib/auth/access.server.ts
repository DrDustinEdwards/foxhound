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
import { accessAdmin } from "@dustinedwards/site-runtime/access";

export interface AdminSession {
  email: string;
}

/**
 * The signed-in admin, or null. Never throws: a refused token, an unreachable
 * key endpoint, and an email off the allowlist all return null.
 */
export function getAdminSession(env: Env, request: Request): Promise<AdminSession | null> {
  // site-runtime's accessAdmin: the Access token (header or cookie) verified,
  // its email on adminEmails(env). Local development's ACCESS_DEV_BYPASS="1"
  // applies only to a localhost URL and admits the first allowlisted email.
  return accessAdmin(request, env);
}
