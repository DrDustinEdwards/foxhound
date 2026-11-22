import Stripe from "stripe";

import { STRIPE_API_VERSION } from "~/lib/constants";

// The Stripe client factory. Built per-request from env so the secret key never leaves the binding.
const NETWORK = {
  maxNetworkRetries: 2,
  timeout: 30_000,
  appInfo: { name: "Foxhound" },
} as const;

export function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    ...NETWORK,
  });
}

/**
 * A Stripe client scoped to a CONNECTED account, built from its decrypted OAuth access token
 * (app/lib/stripe/encryption.ts decryptToken). Standard Connect's access token is a full API key
 * for that account, so no `stripeAccount` header is needed. Callers must never log the token
 * (ARCHITECTURE.md non-negotiable #5).
 */
export function getConnectedStripe(accessToken: string): Stripe {
  return new Stripe(accessToken, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    ...NETWORK,
  });
}
