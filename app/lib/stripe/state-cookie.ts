import {
  STRIPE_OAUTH_STATE_COOKIE,
  STRIPE_OAUTH_STATE_TTL_SECONDS,
} from "~/lib/constants";

// CSRF state cookie for the Stripe Connect OAuth flow (legacy rule: a state
// cookie set on start and matched on callback). HttpOnly + Secure + SameSite=Lax.

export function setStateCookie(state: string): string {
  return `${STRIPE_OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STRIPE_OAUTH_STATE_TTL_SECONDS}`;
}

export function clearStateCookie(): string {
  return `${STRIPE_OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readStateCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === STRIPE_OAUTH_STATE_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}
