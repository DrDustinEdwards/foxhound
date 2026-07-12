import {
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
export function connectRedirectUri(env: Env): string {
  if (!env.BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is not set");
  return `${env.BETTER_AUTH_URL}/connect/callback`;
}

/** Build the Stripe Connect authorize URL with a CSRF state value. */
export function buildConnectAuthorizeUrl(env: Env, state: string): string {
  if (!env.STRIPE_CLIENT_ID) throw new Error("STRIPE_CLIENT_ID is not set");
  const params = new URLSearchParams({
    client_id: env.STRIPE_CLIENT_ID,
    scope: STRIPE_CONNECT_SCOPE,
    response_type: "code",
    state,
    redirect_uri: connectRedirectUri(env),
  });
  return `${STRIPE_CONNECT_AUTHORIZE_URL}?${params.toString()}`;
}

export interface StripeOAuthResult {
  stripeUserId: string;
  /** Plaintext access token. Encrypt before storage; never log. */
  accessToken: string;
  publishableKey: string | null;
  scope: string | null;
}

/** Exchange an authorization code for connected-account credentials. */
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
  return {
    stripeUserId: token.stripe_user_id,
    accessToken: token.access_token,
    publishableKey: token.stripe_publishable_key ?? null,
    scope: token.scope ?? null,
  };
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
