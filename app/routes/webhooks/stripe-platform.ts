import { processPlatformWebhook } from "~/lib/billing/platform-webhook";
import { stripeWebhookRoute } from "~/lib/stripe/verified-event";

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
// Nothing was claimed on an error, so Stripe's redelivery is a clean second attempt.
const route = stripeWebhookRoute({
  secretKey: "STRIPE_PLATFORM_WEBHOOK_SECRET",
  endpoint: "stripe-platform-webhook",
  errorScope: "stripe-platform-billing-dispatch",
  process: processPlatformWebhook,
});
export const loader = route.loader;
export const action = route.action;
