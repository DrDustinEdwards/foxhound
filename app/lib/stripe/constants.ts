/**
 * Pinned Stripe API version (the installed `stripe` package's default), so
 * behavior does not depend on the account's dashboard default.
 */
export const STRIPE_API_VERSION = "2026-11-18.endive";
/**
 * The public-preview channel of the same release, for preview-only endpoints
 * such as FX Quotes, which Stripe serves only on a `.preview` version.
 */
export const STRIPE_PREVIEW_API_VERSION = STRIPE_API_VERSION.replace(/\.[a-z]+$/, ".preview");
/** Stripe Connect OAuth authorize endpoint. */
export const STRIPE_CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";
/**
 * Connect OAuth scope at merchant onboarding (/connect): read_write. An audit
 * prospect who converts re-authorizes here.
 */
export const STRIPE_CONNECT_SCOPE = "read_write";
export const STRIPE_AUDIT_SCOPE = "read_write";
/** CSRF state cookie name for the Connect OAuth flow. */
export const STRIPE_OAUTH_STATE_COOKIE = "__Host-stripe_oauth_state";
/**
 * CSRF state cookie name for the AUDIT OAuth flow: a separate name from
 * Connect's because both flows can be in flight in one browser, and a shared
 * one would overwrite the other's state (`invalid_state`).
 */
export const AUDIT_OAUTH_STATE_COOKIE = "__Host-audit_oauth_state";
/** Connect OAuth state cookie lifetime: 10 minutes. */
export const STRIPE_OAUTH_STATE_TTL_SECONDS = 600;
/**
 * The anonymous audit's access-token cookie: HttpOnly, Secure, SameSite=Lax,
 * five minutes, scoped to /audit. It carries the whole token (stored in no
 * table); the Stripe grant is revoked when this window ends unless a Foxhound
 * account holds that Stripe account live.
 */
// __Secure-, not __Host-: __Host- requires Path=/, and Path=/audit is what
// keeps the token off every other request.
export const AUDIT_TOKEN_COOKIE = "__Secure-audit_access_token";
/**
 * Audit access-token cookie lifetime: 5 minutes. Also the delay before Foxhound
 * revokes the audit's Stripe grant.
 */
export const AUDIT_TOKEN_TTL_SECONDS = 300;
