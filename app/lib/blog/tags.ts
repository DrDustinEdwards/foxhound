// The 8 canonical blog tags (Blog Roadmap Part 5, already decided, not this
// pass's call). Every place a tag list or label map appears (tag archive
// page, sitemap, llms.txt) reads from here, not a re-typed literal.
export const CANONICAL_TAGS = [
  "payment-recovery",
  "disputes",
  "subscription-intelligence",
  "decline-codes",
  "stripe-for-saas",
  "saas-pricing",
  "saas-metrics",
  "comparisons",
] as const;

const TAG_LABELS: Record<string, string> = {
  "payment-recovery": "Payment Recovery",
  disputes: "Dispute Handling",
  "subscription-intelligence": "Subscription Intelligence",
  "decline-codes": "Decline Codes",
  "stripe-for-saas": "Stripe for SaaS",
  "saas-pricing": "SaaS Pricing",
  "saas-metrics": "SaaS Metrics",
  comparisons: "Comparisons",
};

// Ported from legacy labelFor (Phase 6 Pass 2): known tags get a curated
// label, anything unrecognized falls back to a humanized kebab-case string
// rather than 404ing, so a stray or future tag never breaks the archive page.
export function labelForTag(tag: string): string {
  return TAG_LABELS[tag] ?? tag.replace(/-/g, " ");
}
