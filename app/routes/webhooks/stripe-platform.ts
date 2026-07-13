import * as Sentry from "@sentry/cloudflare";

import { getDb, webhookEvents } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { constructStripeEvent } from "~/lib/stripe/webhook";

import type { Route } from "./+types/stripe-platform";

// Platform Stripe webhook (ROUTES.md: /webhooks/stripe-platform). This is
// Foxhound's OWN Stripe account (billing our merchants), verified with
// STRIPE_PLATFORM_WEBHOOK_SECRET. Phase 4c only claims the event (idempotent on
// the webhook_events unique index); the billing reconciliation dispatch
// (invoice.paid on our invoices -> mark billing_invoices paid) lands in Phase 4d,
// which owns the platform billing model. No connected account here, so the claim
// is a plain insert, not a per-account money write.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const { env } = context.get(cloudflareContext);
  const secret = env.STRIPE_PLATFORM_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("webhook not configured", { status: 500 });
  }

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event;
  try {
    event = await constructStripeEvent(env, payload, signature, secret);
  } catch (err) {
    Sentry.captureException(err, {
      extra: { scope: "stripe-platform-webhook-signature", hasSignature: signature.length > 0 },
    });
    return new Response("invalid signature", { status: 400 });
  }

  // Claim only (idempotent). Dispatch of platform billing events is Phase 4d.
  try {
    await getDb(env).insert(webhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      receivedAt: new Date(),
      accountId: null,
      processed: true,
      processingStartedAt: new Date(),
      payload: event,
    });
  } catch {
    // Unique-index violation = already claimed; idempotent no-op.
  }
  return Response.json({ received: true });
}
