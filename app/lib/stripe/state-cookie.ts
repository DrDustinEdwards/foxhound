import {
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  AUDIT_TOKEN_TTL_SECONDS,
  STRIPE_OAUTH_STATE_COOKIE,
  STRIPE_OAUTH_STATE_TTL_SECONDS,
} from "~/lib/constants";

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
 * The anonymous audit's access-token cookie, at legacy's semantics exactly
 * (app/audit/callback/route.ts:51-56).
 *
 * PATH=/audit IS NOT DECORATION. It is what keeps a live Stripe access token off
 * every other request this browser makes to this origin, including the ones that
 * reach the money paths. Legacy scopes it the same way and the comment above its
 * redirect says why the token is not in the URL either: history, logs, referrer.
 */
export function setAuditTokenCookie(token: string): string {
  return `${AUDIT_TOKEN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/audit; Max-Age=${AUDIT_TOKEN_TTL_SECONDS}`;
}

export function clearAuditTokenCookie(): string {
  return `${AUDIT_TOKEN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/audit; Max-Age=0`;
}

export function readAuditTokenCookie(request: Request): string | null {
  return readCookie(request, AUDIT_TOKEN_COOKIE);
}
