import type Stripe from "stripe";

import { getStripe } from "./client";

// Stripe webhook signature verification (ARCHITECTURE.md non-negotiable #5:
// constructEvent() on every webhook with the correct secret). Phase 4a provides
// the helper; the webhook ENDPOINTS that call it (connected-account + platform)
// are built in Phase 4c. constructEventAsync is the Workers-safe variant (it
// uses Web Crypto, not Node crypto).
//
// Each endpoint passes ITS OWN signing secret:
//   /webhooks/stripe          -> STRIPE_WEBHOOK_SECRET
//   /webhooks/stripe-platform -> STRIPE_PLATFORM_WEBHOOK_SECRET
export async function constructStripeEvent(
  env: Env,
  payload: string,
  signatureHeader: string,
  signingSecret: string,
): Promise<Stripe.Event> {
  return getStripe(env).webhooks.constructEventAsync(
    payload,
    signatureHeader,
    signingSecret,
  );
}
