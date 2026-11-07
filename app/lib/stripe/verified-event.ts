import * as Sentry from "@sentry/cloudflare";
import { readText } from "@dustinedwards/site-runtime/body";
import { logEvent } from "@dustinedwards/site-runtime/log";
import type Stripe from "stripe";

import { WEBHOOK_BODY_MAX_BYTES } from "~/lib/http/body";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { constructStripeEvent } from "~/lib/stripe/webhook";

const SIGNATURE_REPORTS_PER_HOUR = 5;

/**
 * A webhook whose signature failed. A secret-rotation slip stops payment ingestion, so make it visible;
 * but the endpoints are public and every junk POST lands here too. Report at most
 * SIGNATURE_REPORTS_PER_HOUR an hour per endpoint across the whole Worker (one shared key, so no caller
 * can spread around it): enough to show a rotation slip, not enough to spend the Sentry quota or bury
 * real alerts. The rest go to the Workers log only. The context carries no secret material.
 */
async function reportBadSignature(
  env: Env,
  endpoint: string,
  err: unknown,
  hasSignature: boolean,
): Promise<void> {
  const scope = `${endpoint}-signature`;
  if (await isWithinRateLimit(env, "sentry", scope, SIGNATURE_REPORTS_PER_HOUR, 3_600_000)) {
    Sentry.captureException(err, { extra: { scope, hasSignature } });
  } else {
    logEvent("stripe_webhook_signature_invalid", { endpoint, reported: false }, { level: "warn" });
  }
}

/**
 * The front of both Stripe webhook endpoints: a POST, a configured signing secret (a missing one fails
 * closed with a 500 so Stripe retries instead of dropping events), a bounded body, and a verified
 * signature. Returns the event, or the Response to send back.
 */
export async function verifyStripeRequest(
  request: Request,
  env: Env,
  secret: string | undefined,
  endpoint: string,
): Promise<Stripe.Event | Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!secret) {
    return new Response("webhook not configured", { status: 500 });
  }
  const payload = await readText(request, WEBHOOK_BODY_MAX_BYTES);
  const signature = request.headers.get("stripe-signature") ?? "";
  try {
    return await constructStripeEvent(env, payload, signature, secret);
  } catch (err) {
    await reportBadSignature(env, endpoint, err, signature.length > 0);
    return new Response("invalid signature", { status: 400 });
  }
}
