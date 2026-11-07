import * as Sentry from "@sentry/cloudflare";

import { processPlatformWebhook } from "~/lib/billing/platform-webhook";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { verifyStripeRequest } from "~/lib/stripe/verified-event";

import type { Route } from "./+types/stripe-platform";

// Platform Stripe webhook (ROUTES.md: /webhooks/stripe-platform). This is
// Foxhound's OWN Stripe account (billing our merchants), verified with
// STRIPE_PLATFORM_WEBHOOK_SECRET. The claim and the billing_invoices status
// update commit as ONE atomic per-account money-write batch, so a dispatch
// failure rolls the claim back too. Response codes now match the connected
// endpoint:
//   200 applied/duplicate/ignored (Stripe stops retrying)
//   400 bad signature
//   500 processing error (Stripe retries; nothing was claimed)
//
// This endpoint used to claim first, swallow any dispatch failure, and always
// return 200. A dropped invoice.paid was therefore permanent: marked processed,
// never redelivered, and with the platform webhook itself being the only
// reconciler for platform invoice status, nothing else would have caught it.
// A GET never reaches the action; without a loader it rendered as a 400 "Unexpected Server Error".
export function loader() {
  return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const event = await verifyStripeRequest(
    request,
    env,
    env.STRIPE_PLATFORM_WEBHOOK_SECRET,
    "stripe-platform-webhook",
  );
  if (event instanceof Response) return event;

  const outcome = await processPlatformWebhook(env, event, new Date());
  if (outcome.status === "error") {
    Sentry.captureException(new Error(outcome.message), {
      extra: {
        scope: "stripe-platform-billing-dispatch",
        eventType: event.type,
        eventId: event.id,
      },
    });
    // Nothing was claimed, so Stripe's redelivery is a clean second attempt.
    return new Response("processing error", { status: 500 });
  }
  return Response.json({ received: true, outcome: outcome.status });
}
