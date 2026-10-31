import * as Sentry from "@sentry/cloudflare";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { constructStripeEvent } from "~/lib/stripe/webhook";
import { processConnectedWebhook } from "~/lib/webhooks/process";

import type { Route } from "./+types/stripe";
import { readText, WEBHOOK_BODY_MAX_BYTES } from "~/lib/http/body";

// Connected-account Stripe webhook (ROUTES.md: /webhooks/stripe). Signature is
// verified with STRIPE_WEBHOOK_SECRET (constructEventAsync, Web Crypto). The
// event is then claimed + processed atomically through the per-account money-write
// DO (exactly-once on the webhook_events unique index). Response codes:
//   200 applied/duplicate/ignored (Stripe stops retrying)
//   400 bad signature / method
//   500 processing error (Stripe retries; the batch is atomic + idempotent)
//
// Live delivery + signature verification are exercised on staging via the Stripe
// CLI in Phase 8; this pass wires and unit-proves the seams.
// A GET never reaches the action; without a loader it rendered as a 400 "Unexpected Server Error".
export function loader() {
  return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const { env } = context.get(cloudflareContext);
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration: fail closed so events are retried, not silently dropped.
    return new Response("webhook not configured", { status: 500 });
  }

  const payload = await readText(request, WEBHOOK_BODY_MAX_BYTES);
  const signature = request.headers.get("stripe-signature") ?? "";

  let event;
  try {
    event = await constructStripeEvent(env, payload, signature, secret);
  } catch (err) {
    // A secret-rotation slip stops payment ingestion; make it visible. Context
    // carries no secret material.
    Sentry.captureException(err, {
      extra: { scope: "stripe-webhook-signature", hasSignature: signature.length > 0 },
    });
    return new Response("invalid signature", { status: 400 });
  }

  const outcome = await processConnectedWebhook(env, event, new Date());
  if (outcome.status === "error") {
    Sentry.captureException(new Error(outcome.message), {
      extra: { scope: "stripe-webhook-process", eventType: event.type, eventId: event.id },
    });
    return new Response("processing error", { status: 500 });
  }
  return Response.json({ received: true, outcome: outcome.status });
}
