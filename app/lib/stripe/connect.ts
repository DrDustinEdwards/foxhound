import type Stripe from "stripe";

import {
  STRIPE_AUDIT_SCOPE,
  STRIPE_CONNECT_AUTHORIZE_URL,
  STRIPE_CONNECT_SCOPE,
} from "~/lib/constants";

import { getStripe } from "./client";

// Stripe Connect OAuth (ported from legacy app/api/auth/stripe/{connect,callback}).
// Phase 3 stubbed /connect/callback; this is the real token exchange. In the
// Foxhound model the account already exists (Phase 3 account setup), so the
// callback attaches the connection to the resolved account rather than creating
// one (legacy created the account inside the callback).

/** The redirect_uri registered with Stripe and sent on both authorize + token. */
function connectRedirectUri(env: Env): string {
  if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is not set");
  return `${env.BETTER_AUTH_URL}/connect/callback`;
}

/**
 * The anonymous audit's redirect_uri (phase (f)). A SECOND registered URI, which
 * is legacy's shape too: its audit flow lands on /audit/callback while its
 * merchant flow lands on the auth callback, and Stripe matches redirect_uri
 * exactly. Both have to be registered on the platform's Connect settings before
 * either flow works in production; that is on core.md's credentials list.
 */
function auditRedirectUri(env: Env): string {
  if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is not set");
  return `${env.BETTER_AUTH_URL}/audit/callback`;
}

/**
 * Build the Stripe Connect authorize URL with a CSRF state value.
 *
 * THE SCOPE IS A PARAMETER WITH read_write AS ITS DEFAULT, so the onboarding
 * caller is unchanged and the audit caller has to say what it wants. Defaulting
 * to the write scope is deliberate rather than lazy: an audit route that forgets
 * to pass a scope gets the loud parity default that every plant is watching,
 * not a quiet read-only one nobody would notice was missing from the audit.
 */
export function buildConnectAuthorizeUrl(
  env: Env,
  state: string,
  options: { scope?: string; redirectUri?: string } = {},
): string {
  if (!env.STRIPE_CLIENT_ID) throw new Error("STRIPE_CLIENT_ID is not set");
  const params = new URLSearchParams({
    client_id: env.STRIPE_CLIENT_ID,
    scope: options.scope ?? STRIPE_CONNECT_SCOPE,
    response_type: "code",
    state,
    redirect_uri: options.redirectUri ?? connectRedirectUri(env),
  });
  return `${STRIPE_CONNECT_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * The audit flow's authorize URL: READ-ONLY, always, and the only caller that
 * names STRIPE_AUDIT_SCOPE.
 *
 * 362 ruling 1, and the reason it is its own function rather than an options
 * object at the call site: the scope is the whole ruling, so it belongs
 * somewhere a plant can assert it once and have it hold for every caller that
 * ever starts an audit.
 */
export function buildAuditAuthorizeUrl(env: Env, state: string): string {
  return buildConnectAuthorizeUrl(env, state, {
    scope: STRIPE_AUDIT_SCOPE,
    redirectUri: auditRedirectUri(env),
  });
}

export interface StripeOAuthResult {
  stripeUserId: string;
  /** Plaintext access token. Encrypt before storage; never log. */
  accessToken: string;
  publishableKey: string | null;
  scope: string | null;
}

/**
 * Exchange an authorization code for connected-account credentials.
 *
 * A TEST-MODE TOKEN IS REFUSED. Foxhound runs on a live key only and claims and
 * ignores every test-mode webhook, so a connection made with a test key (a
 * misconfigured STRIPE_SECRET_KEY) would look connected and never recover a
 * payment. Strictly true: a response without the field is refused too. The
 * message names the cause and carries no token, so the callback can log it.
 */
export async function exchangeConnectCode(
  env: Env,
  code: string,
): Promise<StripeOAuthResult> {
  const token = await getStripe(env).oauth.token({
    grant_type: "authorization_code",
    code,
  });
  if (!token.stripe_user_id || !token.access_token) {
    throw new Error("Stripe OAuth token response missing stripe_user_id/access_token");
  }
  if (token.livemode !== true) {
    throw new Error("Stripe OAuth returned a test-mode token; check STRIPE_SECRET_KEY is a live key");
  }
  return {
    stripeUserId: token.stripe_user_id,
    accessToken: token.access_token,
    publishableKey: token.stripe_publishable_key ?? null,
    scope: token.scope ?? null,
  };
}

/** True when a merchant connection's granted scope is the one onboarding asks
 *  for. Here so the write scope is named in this module and nowhere else. */
export function isMerchantConnectScope(scope: string | null): boolean {
  return scope === STRIPE_CONNECT_SCOPE;
}

/** Best-effort display name for the connected account. Null on any failure. */
export async function fetchConnectedAccountName(
  env: Env,
  stripeUserId: string,
): Promise<string | null> {
  try {
    const account = await getStripe(env).accounts.retrieve(stripeUserId);
    return (
      account.business_profile?.name ??
      account.settings?.dashboard?.display_name ??
      null
    );
  } catch {
    // Non-fatal: the connection still works without a display name.
    return null;
  }
}

export interface DeauthorizeResult {
  ok: boolean;
  error?: string;
}

/**
 * Revoke a Standard Connect OAuth grant against an already-constructed Stripe
 * client. Isolated so a fake client can drive it in tests without a live call
 * (mirrors app/lib/disputes/submission.ts's submitDisputeEvidenceWithClient).
 * Never throws: a Stripe-side failure reports ok:false so the caller can log
 * and retry later rather than propagate.
 */
async function deauthorizeConnectedAccountWithClient(
  stripe: Stripe,
  clientId: string,
  stripeUserId: string,
): Promise<DeauthorizeResult> {
  try {
    await stripe.oauth.deauthorize({ client_id: clientId, stripe_user_id: stripeUserId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Default IO: build the platform client, deauthorize (admin Pass 2: merchant
 * cancel). A wired-but-inert live Stripe seam like every other Phase-8-verified
 * call in this module. Callers MUST commit the local cancel state
 * (accounts.cancelledAt + stripe_connections.disconnectedAt) BEFORE calling
 * this, and must never roll that local state back on a deauthorize failure -
 * the merchant is canceled either way; a failed deauthorize only means the
 * OAuth grant itself needs a retry, not that processing should resume.
 */
export async function deauthorizeConnectedAccount(
  env: Env,
  stripeUserId: string,
): Promise<DeauthorizeResult> {
  if (!env.STRIPE_CLIENT_ID) {
    return { ok: false, error: "STRIPE_CLIENT_ID is not set" };
  }
  return deauthorizeConnectedAccountWithClient(getStripe(env), env.STRIPE_CLIENT_ID, stripeUserId);
}
