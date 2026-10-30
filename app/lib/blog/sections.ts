// Curated home-page topic sections (ported from legacy
// app/(marketing)/blog/page.tsx SECTIONS, Phase 6 Pass 2). Order controls
// render order; slugs inside control card order within a section. These are
// the REAL slugs the manual STOP A import will land (verbatim, do not
// invent new ones here). Missing slugs are silently skipped by the loader,
// so an unpublished pick degrades cleanly. The loader shows a section only
// when at least one curated post resolves AND a published post carries the
// section's tag, so "See all" never leads to an empty or missing tag page
// (see blog/index.tsx). Identical to Recova's SECTIONS (diffed at J19).
export interface BlogSectionConfig {
  id: string;
  label: string;
  description: string;
  tagHref: string;
  slugs: string[];
}

export const SECTIONS: BlogSectionConfig[] = [
  {
    id: "payment-recovery",
    label: "Payment Recovery",
    description: "How failed payments happen, how to recover them, and how to prevent them.",
    tagHref: "/blog/tag/payment-recovery",
    slugs: [
      "stripe-failed-payment-recovery",
      "how-to-reduce-involuntary-churn-stripe",
      "dunning-email-sequence",
      "expiring-cards-silent-mrr-killer",
    ],
  },
  {
    id: "disputes",
    label: "Dispute Handling",
    description: "Chargebacks, evidence, rebuttal letters, and how to prevent disputes before they file.",
    tagHref: "/blog/tag/disputes",
    slugs: [
      "stripe-disputes-guide",
      "what-is-friendly-fraud",
      "how-to-prevent-chargebacks",
      "visa-compelling-evidence-3",
    ],
  },
  {
    id: "subscription-intelligence",
    label: "Subscription Intelligence",
    description: "The billing signals that predict churn before your customers cancel.",
    tagHref: "/blog/tag/subscription-intelligence",
    slugs: [
      "subscription-intelligence-churn-prediction",
      "net-revenue-retention-guide",
      "annual-to-monthly-churn-signal",
      "payment-failure-as-churn-signal",
    ],
  },
  {
    id: "decline-codes",
    label: "Stripe Decline Codes",
    description: "Every major Stripe decline code, what it means, and the right recovery response.",
    tagHref: "/blog/tag/decline-codes",
    slugs: [
      "stripe-decline-codes",
      "stripe-generic-decline",
      "stripe-insufficient-funds",
      "stripe-do-not-honor",
    ],
  },
];
