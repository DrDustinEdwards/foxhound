import {
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  DECLINE_CATEGORY_PHRASE,
} from "~/lib/marketing/decline-categories";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection } from "~/lib/marketing/features-content";

export function intelligenceSection({ nightly, Nightly }: FeatureCadence): FeatureSection {
  return {
    id: "intelligence",
    label: "Intelligence",
    title: "Intelligence",
    intro:
      "What Foxhound figures out on its own: about your customers, your payments, and how to handle both.",
    features: [
      {
        name: "Decline classification",
        description: `Maps every Stripe decline code to one of ${DECLINE_CATEGORY_COUNT_WORD_LOWER} categories: ${DECLINE_CATEGORY_PHRASE}. Different category, different sequence.`,
        product: "Recovery",
      },
      {
        name: "Fraud decline detection",
        description: "Fraud-category declines are never retried. The customer gets emails only.",
        product: "Recovery",
      },
      {
        name: "Customer health scoring",
        description:
          "0-100 score per customer from payment timing, billing changes, refunds and disputes, engagement with recovery emails, tenure, and a prepaid card on file.",
        product: "Intelligence",
      },
      {
        // The nightly scoring batch writes one per customer (ai-run.server.ts) from rules that produce four actions (recommend.ts).
        name: "4 recommendation types",
        description:
          "Every customer gets one: personal outreach, continue automated, continue automated (priority), or continue automated (deprioritize).",
        product: "Intelligence",
      },
      {
        name: "AI recovery email generation",
        description:
          "Claude writes each email in your brand voice. Dashes and filler phrases are stripped, and a quality check holds back any copy that reveals the schedule.",
        product: "Recovery",
      },
      {
        name: "AI audit summary",
        description: "A plain-English diagnostic summary at the top of every audit result.",
        product: "Audit",
      },
      {
        name: `${Nightly} narrative`,
        description: `A plain-English narrative of the account's MRR and at-risk customers, written ${nightly} from their real scores. A template, not AI, so it states only the numbers.`,
        product: "Intelligence",
      },
      {
        name: "Cross-product dispute signal",
        description:
          "Each customer's disputes, won and lost, are counted into their Intelligence record, and disputes count against the health score.",
        product: "Disputes",
      },
      {
        name: "Card Account Updater advisory",
        description:
          "The audit counts the cards Stripe's Card Account Updater refreshed beside the expired-card declines in the same window, so you can see whether it is working.",
        product: "Audit",
      },
      {
        name: "Renewal noise filtering",
        description:
          "A first failed payment waits while Stripe's own retries run. Foxhound's sequence starts when Stripe gives up, so Stripe's retry events never start a duplicate sequence.",
        product: "Recovery",
      },
    ],
  };
}
