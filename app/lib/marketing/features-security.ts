import { STRIPE_WRITES, STRIPE_WRITES_LIMITS } from "~/lib/marketing/trust-copy";
import { AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import type { FeatureSection } from "~/lib/marketing/features-content";

export function securitySection(): FeatureSection {
  return {
    id: "security",
    label: "Security and compliance",
    title: "Security and compliance",
    intro: "What protects you, your customers, and your Stripe data.",
    features: [
      {
        name: "Narrow Stripe scope",
        description: `Foxhound requests read and write Stripe Connect access, because retrying a failed invoice is a write. It writes for these things and no others: ${STRIPE_WRITES}. It ${STRIPE_WRITES_LIMITS}. The free audit only reads, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes.`,
        product: "Platform",
      },
      {
        name: "Tenant isolation",
        description:
          "D1 has no row-level security, so every query helper takes the account as a required first argument. No query can reach another account's data.",
        product: "Platform",
      },
      {
        name: "AES-256-GCM encryption",
        description:
          "All Stripe access tokens encrypted at rest. Decrypted only in memory when used.",
        product: "Platform",
      },
      {
        name: "Stripe webhook verification",
        description:
          "All incoming Stripe webhooks verified with constructEventAsync signature verification. Stripe's default replay window enforced.",
        product: "Platform",
      },
      {
        name: "Scheduler-only crons",
        description: "Crons run only from Cloudflare's scheduler. No HTTP route can start one.",
        product: "Platform",
      },
      {
        name: "PKCE S256 enforced",
        description:
          "The admin connector's OAuth flow accepts only S256 code challenges. Plain is refused.",
        product: "Platform",
      },
      {
        name: "Admin double-gate",
        description:
          "Admin needs Cloudflare Access and an address on the admin list. The admin connector asks the admin API again on every call.",
        product: "Platform",
      },
      {
        name: "Rate limiting",
        description: "Durable Object rate limiting on the audit, sign-in, and the MCP endpoint.",
        product: "Platform",
      },
      {
        name: "CAN-SPAM compliance",
        description:
          "List-Unsubscribe headers, signed unsubscribe tokens, a suppression list, and a physical address in all commercial emails. A send without one is refused.",
        product: "Platform",
      },
      {
        name: "Accessibility",
        description:
          "Foxhound is built to be accessible and is tested with screen-reader and keyboard tools. If something doesn't work for you, tell us and we'll fix it. prefers-reduced-motion, prefers-contrast: more, and forced-colors are all supported.",
        product: "Platform",
      },
      {
        name: "CVD accessibility",
        description: "Status is never color alone: every status badge carries its word.",
        product: "Platform",
      },
      {
        name: "Disposable email blocklist",
        description: "Disposable email domains blocked at signup.",
        product: "Platform",
      },
    ],
  };
}
