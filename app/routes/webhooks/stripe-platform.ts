import { processPlatformWebhook } from "~/lib/billing/platform-webhook";
import { stripeWebhookRoute } from "~/lib/stripe/verified-event";

// Platform Stripe webhook (/webhooks/stripe-platform). This is Foxhound's OWN Stripe account (billing our merchants), verified with STRIPE_PLATFORM_WEBHOOK_SECRET. The claim and the billing_invoices status update commit as ONE atomic per-account money-write batch, so a dispatch failure rolls the claim back too. Response codes: 200 applied/duplicate/ignored (Stripe stops retrying); 400 bad signature; 500 processing error (Stripe retries; nothing was claimed, so redelivery is a clean second attempt). Never claim first and swallow a dispatch failure: a dropped invoice.paid would be permanent, with this webhook the only reconciler for platform invoice status. A GET never reaches the action; without a loader it rendered as a 400 "Unexpected Server Error".
const route = stripeWebhookRoute({
  secretKey: "STRIPE_PLATFORM_WEBHOOK_SECRET",
  endpoint: "stripe-platform-webhook",
  errorScope: "stripe-platform-billing-dispatch",
  process: processPlatformWebhook,
});
export const loader = route.loader;
export const action = route.action;
