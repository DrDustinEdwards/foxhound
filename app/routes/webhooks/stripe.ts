import * as Sentry from "@sentry/cloudflare";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { verifyStripeRequest } from "~/lib/stripe/verified-event";
import { processConnectedWebhook } from "~/lib/webhooks/process";

import type { Route } from "./+types/stripe";

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
  const { env } = context.get(cloudflareContext);
  const event = await verifyStripeRequest(
    request,
    env,
    env.STRIPE_WEBHOOK_SECRET,
    "stripe-webhook",
  );
  if (event instanceof Response) return event;

  const outcome = await processConnectedWebhook(env, event, new Date());
  if (outcome.status === "error") {
    Sentry.captureException(new Error(outcome.message), {
      extra: { scope: "stripe-webhook-process", eventType: event.type, eventId: event.id },
    });
    return new Response("processing error", { status: 500 });
  }
  return Response.json({ received: true, outcome: outcome.status });
}
