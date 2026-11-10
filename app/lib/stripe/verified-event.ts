import * as Sentry from "@sentry/cloudflare";
import { readText } from "@dustinedwards/site-runtime/body";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { logEvent } from "@dustinedwards/site-runtime/log";
import type { RouterContextProvider } from "react-router";
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
 *
 * The cap fails CLOSED: when the limiter cannot answer, nothing is reported. Failing open would let every
 * junk POST through to Sentry exactly when the cap cannot count, which is the flood the cap exists to stop.
 * The limiter's own outage is logged by site-runtime, and the request is still logged here.
 */
async function reportBadSignature(
  env: Env,
  endpoint: string,
  err: unknown,
  hasSignature: boolean,
): Promise<void> {
  const scope = `${endpoint}-signature`;
  let withinCap = false;
  try {
    withinCap = await isWithinRateLimit(
      env,
      "sentry",
      scope,
      SIGNATURE_REPORTS_PER_HOUR,
      3_600_000,
      { failClosed: true },
    );
  } catch {
    // The limiter is unavailable: treat the cap as spent.
  }
  if (withinCap) {
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
async function verifyStripeRequest(
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

/**
 * A Stripe webhook route's loader and action. A GET never reaches the action, and without a loader it rendered
 * as a 400 "Unexpected Server Error". The action verifies the request (`verifyStripeRequest`), hands the event to
 * `process`, and answers 200 for an applied, duplicate or ignored event and 500 for an error (Stripe retries).
 * `secretKey` names the signing secret in the environment; `endpoint` and `errorScope` name the endpoint in Sentry.
 */
export function stripeWebhookRoute(options: {
  secretKey: "STRIPE_WEBHOOK_SECRET" | "STRIPE_PLATFORM_WEBHOOK_SECRET";
  endpoint: string;
  errorScope: string;
  process: (
    env: Env,
    event: Stripe.Event,
    now: Date,
  ) => Promise<{ status: string; message?: string }>;
}) {
  return {
    loader() {
      return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
    },
    async action({
      request,
      context,
    }: {
      request: Request;
      context: Readonly<RouterContextProvider>;
    }) {
      const { env } = context.get(cloudflareContext);
      const event = await verifyStripeRequest(
        request,
        env,
        env[options.secretKey],
        options.endpoint,
      );
      if (event instanceof Response) return event;
      const outcome = await options.process(env, event, new Date());
      if (outcome.status === "error") {
        Sentry.captureException(new Error(outcome.message), {
          extra: { scope: options.errorScope, eventType: event.type, eventId: event.id },
        });
        return new Response("processing error", { status: 500 });
      }
      return Response.json({ received: true, outcome: outcome.status });
    },
  };
}
