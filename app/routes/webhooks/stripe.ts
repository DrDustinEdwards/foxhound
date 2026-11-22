import { stripeWebhookRoute } from "~/lib/stripe/verified-event";
import { processConnectedWebhook } from "~/lib/webhooks/process";

// Connected-account Stripe webhook (/webhooks/stripe). Signature is verified with STRIPE_WEBHOOK_SECRET (constructEventAsync, Web Crypto). The event is then claimed + processed atomically through the per-account money-write DO (exactly-once on the webhook_events unique index). Response codes: 200 applied/duplicate/ignored (Stripe stops retrying); 400 bad signature / method; 500 processing error (Stripe retries; the batch is atomic + idempotent).
const route = stripeWebhookRoute({
  secretKey: "STRIPE_WEBHOOK_SECRET",
  endpoint: "stripe-webhook",
  errorScope: "stripe-webhook-process",
  process: processConnectedWebhook,
});
export const loader = route.loader;
export const action = route.action;
