import * as Sentry from "@sentry/cloudflare";

import { getDb, webhookEvents } from "~/db";
import { processPlatformBillingEvent } from "~/lib/billing/platform-webhook";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { constructStripeEvent } from "~/lib/stripe/webhook";

import type { Route } from "./+types/stripe-platform";

// Platform Stripe webhook (ROUTES.md: /webhooks/stripe-platform). This is
// Foxhound's OWN Stripe account (billing our merchants), verified with
// STRIPE_PLATFORM_WEBHOOK_SECRET. The event is claimed exactly-once (webhook_events
// unique index); a newly-claimed billing-invoice event is then dispatched to the
// reconciliation processor (invoice.paid on our invoices -> mark billing_invoices
// paid). No connected account here, so the claim is a plain insert, not a
// per-account money write; the status update it triggers rides the money-write DO.
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

  // Claim exactly-once on the webhook_events unique index; only a newly-claimed
  // event is dispatched, so a replay never re-applies a status change.
  let claimed = false;
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
    claimed = true;
  } catch {
    // Unique-index violation = already claimed; idempotent no-op.
  }

  if (claimed) {
    try {
      await processPlatformBillingEvent(env, event);
    } catch (err) {
      // Reconciliation is best-effort and self-healing on the next event; never
      // fail the webhook (Stripe would retry a 500 and re-hit the claimed event).
      Sentry.captureException(err, { extra: { scope: "stripe-platform-billing-dispatch" } });
    }
  }
  return Response.json({ received: true });
}
