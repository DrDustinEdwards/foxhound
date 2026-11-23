// What Foxhound writes to a merchant's Stripe account, and who receives merchant data, held once for every page that states them (/privacy,
// /security, the home FAQ, features, docs, llms.txt and llms-full.txt). The write list is checked against the code that calls Stripe on a
// connected account: engine/retry-step (invoices.pay), card-update/service (checkout setup session, customers.update and
// subscriptions.update default_payment_method), recovery win-back checkout, disputes/submission (files.create, disputes.update),
// disputes/accept.server (disputes.close) and disputes/fraud-warnings.server (refunds.create). Add a Stripe write there and it goes here.

export const STRIPE_WRITES =
  'retrying payment on an invoice that has already failed, setting a customer\'s default payment method after that customer updates their card, opening a Stripe checkout when a customer updates their card or a former customer chooses to resubscribe, submitting dispute evidence once someone on the team has approved it or auto-submit is on, closing a dispute at Stripe when the owner chooses to accept it, and refunding a charge when the owner presses "Refund this charge" on an early fraud warning';

export const STRIPE_WRITES_LIMITS =
  "never changes prices, products or subscription plans, never charges a customer except by retrying a failed invoice or through a checkout the customer completes, and never reaches payouts or bank accounts";

// Rendered as a list by /privacy and as one sentence by /security.
export const SUBPROCESSORS = [
  { role: "AI Service Providers", name: "Anthropic" },
  { role: "Invoice and Billing", name: "Stripe" },
  { role: "Website Performance Monitoring", name: "Sentry" },
  {
    role: "Cloud Computing Services, Database and File Storage, Email Delivery, and Website Analytics",
    name: "Cloudflare",
  },
  { role: "Off-Site Backup Storage", name: "Amazon Web Services" },
  { role: "Sign-In, if you choose it", name: "Google and Apple" },
] as const;
