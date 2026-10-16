import {
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  AUDIT_TOKEN_TTL_SECONDS,
  STRIPE_OAUTH_STATE_COOKIE,
  STRIPE_OAUTH_STATE_TTL_SECONDS,
} from "~/lib/constants";
import { decryptToken, encryptToken } from "~/lib/stripe/encryption";

// CSRF state cookie for the Stripe Connect OAuth flow (legacy rule: a state
// cookie set on start and matched on callback). HttpOnly + Secure + SameSite=Lax.
//
// TWO STATE COOKIES, ONE PAIR OF FUNCTIONS. Phase (f) added the anonymous audit
// flow, which legacy keeps under its own cookie name (`audit_oauth_state`)
// rather than sharing the connect one, and that separation is load-bearing: the
// two flows can be in flight in the same browser at the same time, and a shared
// name means starting an audit silently invalidates a merchant's half-finished
// /connect. The name is a parameter here rather than a second module, so the
// attributes cannot drift between the two.

export function setStateCookie(
  state: string,
  name: string = STRIPE_OAUTH_STATE_COOKIE,
): string {
  return `${name}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STRIPE_OAUTH_STATE_TTL_SECONDS}`;
}

export function clearStateCookie(name: string = STRIPE_OAUTH_STATE_COOKIE): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function readStateCookie(
  request: Request,
  name: string = STRIPE_OAUTH_STATE_COOKIE,
): string | null {
  return readCookie(request, name);
}

/** The audit flow's state cookie, under legacy's own name. */
export function setAuditStateCookie(state: string): string {
  return setStateCookie(state, AUDIT_OAUTH_STATE_COOKIE);
}

export function clearAuditStateCookie(): string {
  return clearStateCookie(AUDIT_OAUTH_STATE_COOKIE);
}

export function readAuditStateCookie(request: Request): string | null {
  return readCookie(request, AUDIT_OAUTH_STATE_COOKIE);
}

/**
 * What the audit callback learned from Stripe: the read-only token and the
 * Stripe account that granted it. The two travel together and only together.
 */
export interface AuditGrant {
  accessToken: string;
  stripeAccountId: string;
}

/**
 * The anonymous audit's grant cookie, at legacy's lifetime and scope
 * (app/audit/callback/route.ts:51-56): five minutes, HttpOnly, Path=/audit.
 *
 * THE ACCOUNT ID IS SEALED IN WITH THE TOKEN, and that is the whole point of
 * this cookie's shape. Legacy keeps the bare token here and reads the account id
 * from `?account=` on the results page. The visitor can edit the query but not
 * the token, so a merchant who authorized somebody else's Stripe account could
 * put their own id in the URL and have the other account's numbers filed into
 * their own history under their own id (RULES.md 4.14). The results page now
 * takes the account id from here, never from the URL.
 *
 * SEALED WITH AES-GCM under ENCRYPTION_KEY (the same keyring as stored
 * connection tokens), which is authenticated encryption: an edited value fails
 * to open and reads as no grant at all, and the token is not in the cookie in
 * the clear. Nothing is stored server side; the cookie is still the whole grant.
 *
 * PATH=/audit IS NOT DECORATION. It is what keeps a live Stripe access token off
 * every other request this browser makes to this origin, including the ones that
 * reach the money paths. Legacy scopes it the same way and the comment above its
 * redirect says why the token is not in the URL either: history, logs, referrer.
 */
export async function setAuditGrantCookie(env: Env, grant: AuditGrant): Promise<string> {
  const sealed = await encryptToken(
    env,
    JSON.stringify({ t: grant.accessToken, a: grant.stripeAccountId }),
  );
  return `${AUDIT_TOKEN_COOKIE}=${sealed}; HttpOnly; Secure; SameSite=Lax; Path=/audit; Max-Age=${AUDIT_TOKEN_TTL_SECONDS}`;
}

export function clearAuditTokenCookie(): string {
  return `${AUDIT_TOKEN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/audit; Max-Age=0`;
}

/**
 * The grant the callback sealed, or null when there is none: no cookie, a
 * cookie that does not open under this environment's keys (edited, forged, or
 * the bare token an older deploy set), or a sealed value of the wrong shape.
 * Every one of those means the same thing to the caller, which is that the
 * five-minute grant is gone. The decrypt error is never logged: it carries
 * nothing useful and the value it failed on is a credential.
 */
export async function readAuditGrantCookie(env: Env, request: Request): Promise<AuditGrant | null> {
  const raw = readCookie(request, AUDIT_TOKEN_COOKIE);
  if (!raw) return null;
  let opened: unknown;
  try {
    opened = JSON.parse(await decryptToken(env, raw));
  } catch {
    return null;
  }
  if (!opened || typeof opened !== "object") return null;
  const { t, a } = opened as { t?: unknown; a?: unknown };
  if (typeof t !== "string" || !t || typeof a !== "string" || !a) return null;
  return { accessToken: t, stripeAccountId: a };
}
