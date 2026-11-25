import { AUDIT_GRANT_MINUTES } from "~/lib/marketing/audit-access";
import type { FeatureSection, FeatureFacts } from "~/lib/marketing/features-content";

export function integrationSection(facts: FeatureFacts): FeatureSection {
  return {
    id: "integration",
    label: "Integration",
    title: "Integration",
    intro:
      "How Foxhound connects to your existing stack. The free audit only reads. Never changes your prices, products, or plans.",
    features: [
      {
        name: "Stripe Connect OAuth",
        description: `OAuth connection to your Stripe account, read and write, asked for once at /connect. The free audit asks for the same access, because Stripe no longer offers read-only to platforms. It only reads, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes.`,
        product: "Platform",
      },
      {
        name: "Multi-account support",
        description:
          "One person can belong to several accounts, each with its own Stripe connection. Switch between accounts from the header.",
        product: "Platform",
      },
      {
        name: "AES-256-GCM token encryption",
        description: "All Stripe access tokens encrypted at rest in the stripe_connections table.",
        product: "Platform",
      },
      {
        name: "Stripe webhook processing",
        description:
          "Handles invoice.payment_failed and succeeded, subscription cancellations, refunds, and charge.dispute events.",
        product: "Platform",
      },
      {
        name: "Cloudflare Email Service delivery",
        description:
          "All outbound email sent through Cloudflare Email Service, behind one send module. Bounce and complaint events arrive through a queue.",
        product: "Platform",
      },
      {
        name: "MCP Merchant connector",
        description: `An MCP endpoint at /mcp with ${facts.merchantMcpToolCount} tools across Recovery, Disputes, Intelligence, and Audit, authorized by an API key scoped to one account.`,
        product: "Platform",
      },
      {
        name: "MCP Admin connector",
        description:
          "Platform-wide admin access from Claude and other AI clients. A separate Worker at admin-mcp.foxhoundapp.com, signed in through Cloudflare Access.",
        product: "Platform",
      },
      {
        name: "OAuth 2.1 authorization server",
        description:
          "The admin connector is its own OAuth 2.1 authorization server. PKCE S256 only.",
        product: "Platform",
      },
      {
        name: "API keys",
        description:
          "SHA-256 hashed API keys, shown once and revocable. Manage from Settings, API keys.",
        product: "Platform",
      },
      {
        name: "Anthropic API",
        description:
          "Claude Sonnet writes recovery emails and dispute evidence. Claude Haiku writes audit summaries.",
        product: "Platform",
      },
      {
        name: "Cloudflare D1",
        description:
          "The database, reached through Workers bindings. Every query is scoped to one account.",
        product: "Platform",
      },
      {
        name: "Cloudflare Workers",
        description: "One Worker serves the site, the app, the crons, and the email queue.",
        product: "Platform",
      },
      {
        name: "Durable Object rate limiting",
        description: "Rate limiting on sign-in, the audit, and the MCP endpoint.",
        product: "Platform",
      },
    ],
  };
}
