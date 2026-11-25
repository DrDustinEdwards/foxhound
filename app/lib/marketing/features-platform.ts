import { DEMO_BUSINESSES } from "~/lib/demo/constants";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection, FeatureFacts } from "~/lib/marketing/features-content";

export function platformSection(
  { tick, Nightly, monthly }: FeatureCadence,
  facts: FeatureFacts,
): FeatureSection {
  return {
    id: "platform-infra",
    label: "Platform",
    title: "Platform",
    intro: "The infrastructure and data layer underneath everything.",
    features: [
      {
        name: "Full database schema",
        description:
          "Full schema across all platform tables: accounts, stripe_connections, failed_payments, recovery_steps, disputes, customer_context, mrr_snapshots, audit_runs, and more.",
        product: "Platform",
      },
      {
        name: `${facts.cronJobCount} cron jobs`,
        description: `All ${facts.cronJobCount} registered. Scheduled from every ${tick} minutes to ${monthly}. Status visible at /help.`,
        product: "Platform",
      },
      {
        name: "Network Intelligence Layer",
        description:
          "One outcomes write for every material event, serialized per account through a Durable Object. It never blocks the recovery, dispute, or billing path that called it.",
        product: "Platform",
      },
      {
        name: "Cross-product integration points",
        description:
          "Recovery history grounds dispute evidence. Dispute history and recovery engagement feed the Intelligence health score.",
        product: "Platform",
      },
      {
        name: "Outcomes table",
        description:
          "Every recovery, dispute, and alert event written to outcomes with its attribution, which lift and billing read.",
        product: "Platform",
      },
      {
        name: "Demo system",
        description: `Two demo accounts (${DEMO_BUSINESSES.map((b) => b.name).join(", ")}) that open the real app read-only. ${Nightly} reset.`,
        product: "Platform",
      },
      {
        name: "AI cost tracking",
        description: "ai_calls records every Anthropic API call with model, tokens, and cost.",
        product: "Platform",
      },
      {
        name: "Renewal noise filtering",
        description:
          "A failed payment Stripe is still retrying is parked, so Stripe's own retry events never start a duplicate sequence.",
        product: "Platform",
      },
    ],
  };
}
