import {
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  AUDIT_TOKEN_TTL_SECONDS,
  STRIPE_OAUTH_STATE_COOKIE,
  STRIPE_OAUTH_STATE_TTL_SECONDS,
} from "~/lib/stripe/constants";
import { hostCookie, readCookie } from "@dustinedwards/site-runtime/headers";
import { bare, setHostCookie } from "~/lib/http/cookies";
import { decryptToken, encryptToken } from "~/lib/stripe/encryption";

// CSRF state cookie for the Stripe Connect OAuth flow, written by setHostCookie: __Host-, HttpOnly,
// Secure, SameSite=Lax.

export function setOAuthStateCookie(
  state: string,
  name: string = STRIPE_OAUTH_STATE_COOKIE,
): string {
  return setHostCookie(name, encodeURIComponent(state), STRIPE_OAUTH_STATE_TTL_SECONDS);
}

export function clearOAuthStateCookie(name: string = STRIPE_OAUTH_STATE_COOKIE): string {
  return setHostCookie(name, "", 0);
}

export function readOAuthStateCookie(
  request: Request,
  name: string = STRIPE_OAUTH_STATE_COOKIE,
): string | null {
  const raw = readCookie(request, bare(name));
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function setAuditStateCookie(state: string): string {
  return setOAuthStateCookie(state, AUDIT_OAUTH_STATE_COOKIE);
}

export function clearAuditStateCookie(): string {
  return clearOAuthStateCookie(AUDIT_OAUTH_STATE_COOKIE);
}

export function readAuditStateCookie(request: Request): string | null {
  return readOAuthStateCookie(request, AUDIT_OAUTH_STATE_COOKIE);
}

/**
 * What the audit callback learned from Stripe: the audit's token and the
 * Stripe account that granted it. The two travel together and only together.
 */
export interface AuditGrant {
  accessToken: string;
  stripeAccountId: string;
  /** When the grant was sealed (ms), read back from the seal. */
  issuedAt: number;
}

/** What a sealed value must say it is before it counts as an audit grant. */
const AUDIT_GRANT_PURPOSE = "audit-grant";

/** How far ahead of this Worker's clock an issue time may sit (clock skew
 *  between machines). Anything further is not a grant this deploy minted. */
const AUDIT_GRANT_CLOCK_SKEW_MS = 60_000;

/**
 * THE ACCOUNT ID IS SEALED IN WITH THE TOKEN, and that is the whole point of this cookie's shape.
 * The visitor can edit the query but not the token, so a merchant who authorized somebody else's
 * Stripe account could put their own id in the URL and have the other account's numbers filed into
 * their own history under their own id. The results page takes the account id from here, never from the URL.
 */
export async function setAuditGrantCookie(
  env: Env,
  grant: Omit<AuditGrant, "issuedAt">,
  issuedAtMs: number = Date.now(),
): Promise<string> {
  const sealed = await encryptToken(
    env,
    JSON.stringify({
      p: AUDIT_GRANT_PURPOSE,
      t: grant.accessToken,
      a: grant.stripeAccountId,
      iat: issuedAtMs,
    }),
  );
  return hostCookie(bare(AUDIT_TOKEN_COOKIE), sealed, {
    maxAge: AUDIT_TOKEN_TTL_SECONDS,
    path: "/audit",
  });
}

/**
 * The grant the callback sealed, or null when there is none: no cookie, a cookie that does not open
 * under this environment's keys (edited, forged, or the bare token an older deploy set), a sealed
 * value that is not an audit grant or has the wrong shape, or one older than the cookie's five
 * minutes. The decrypt error is never logged: it carries nothing useful and the value it failed on
 * is a credential.
 */
export async function readAuditGrantCookie(
  env: Env,
  request: Request,
  nowMs: number = Date.now(),
): Promise<AuditGrant | null> {
  const raw = readCookie(request, bare(AUDIT_TOKEN_COOKIE));
  if (!raw) return null;
  let opened: unknown;
  try {
    opened = JSON.parse(await decryptToken(env, raw));
  } catch {
    return null;
  }
  if (!opened || typeof opened !== "object") return null;
  const { p, t, a, iat } = opened as { p?: unknown; t?: unknown; a?: unknown; iat?: unknown };
  if (p !== AUDIT_GRANT_PURPOSE) return null;
  if (typeof t !== "string" || !t || typeof a !== "string" || !a) return null;
  // THE FIVE MINUTES ARE THE SERVER'S TOO. Max-Age is only the browser's
  // promise; a value copied out of the browser keeps none, so the seal carries
  // its issue time and anything past the cookie's own life is no grant.
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  const ageMs = nowMs - iat;
  if (ageMs > AUDIT_TOKEN_TTL_SECONDS * 1000 || ageMs < -AUDIT_GRANT_CLOCK_SKEW_MS) return null;
  return { accessToken: t, stripeAccountId: a, issuedAt: iat };
}
