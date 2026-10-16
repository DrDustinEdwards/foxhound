import {
  DISPUTE_FEE_BPS,
  DISPUTE_FEE_CAP_CENTS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  INTELLIGENCE_PRICE_CENTS,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  RECOVERY_SEQUENCE_DAYS,
} from "~/lib/marketing/decline-categories";
import { formatMoneyShort } from "~/lib/money-format";

import type { ProductKey } from "./products";

// /pricing's card, FAQ and meta copy (J54, row M4), out of the route so tests
// can import it. Recova's spec is app/(marketing)/pricing/page.tsx (blob
// 8e91e160), read whole.
//
// THE WORDING IS FROZEN for the claims pass (RULES.md 2.2; m4.txt: card price
// labels, header subtext, CTA microcopy, every feature bullet, card
// descriptions, FAQ answers and the meta description). Only the mechanism
// changed in J54: every number is read from Foxhound's engine constants, never
// typed (RULES.md 2.1), so the rendered text is what it was except where the
// constant said otherwise. One place did: the Recovery bullet read "across 4
// decline categories" against an engine that schedules six; it now reads
// DECLINE_CATEGORY_COUNT, as the card description above it already did (376
// item 18 derived the description and missed the bullet).
//
// Copy history (Phase 6 Pass 1): rewritten from legacy per corrections #1, #3,
// #5 and #8 (baseline-free, review-and-sign disputes, free intelligence tier,
// maturity-window billing).

const pct = (bps: number) => `${bps / 100}%`;
const usd = (cents: number) => formatMoneyShort(cents, "usd");

export interface PricingCard {
  id: ProductKey;
  name: string;
  price: string;
  priceLabel?: string;
  description: string;
  features: string[];
}

// Audit first: the free, no-signup entry point, as Recova orders them.
/** PRICING.md (Intelligence): the free tier, in the words every page uses
 *  (here and /product/intelligence, J58), so the site says one thing. */
export const INTELLIGENCE_FREE_TIER_SENTENCE =
  "MRR, movements, churn, and cohort analytics are free for every Recovery merchant.";

export const PRICING_CARDS: PricingCard[] = [
  {
    id: "audit",
    name: "Audit",
    price: "Free",
    description:
      "Full Stripe diagnostic. Failed invoices, expiring cards, open disputes, and business health. No account required.",
    features: [
      "Failed invoice analysis",
      "Expiring cards timeline",
      "Open dispute summary",
      "Business health metrics",
      "No signup required",
    ],
  },
  {
    id: "recovery",
    name: "Recovery",
    price: pct(RECOVERY_FEE_BPS),
    priceLabel: "of Foxhound-attributed recoveries",
    description: `Silent retries first, then AI-drafted email sequences across ${RECOVERY_SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${DECLINE_CATEGORY_COUNT_WORD_LOWER} different sequences.`,
    features: [
      "Silent retry before any customer email",
      `${RECOVERY_SEQUENCE_DAYS}-day sequences across ${DECLINE_CATEGORY_COUNT} decline categories`,
      "Baseline recoveries Stripe would have gotten anyway are free",
      `No fee until the recovery has matured ${RECOVERY_MATURITY_DAYS} days`,
      "Card-update link on every email",
      "Open and click tracking",
      "No monthly fee",
    ],
  },
  {
    id: "disputes",
    name: "Disputes",
    price: pct(DISPUTE_FEE_BPS),
    priceLabel: `of won disputes, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    description:
      "Evidence drafted from your Stripe data and recovery history. You review and sign every submission.",
    features: [
      "Evidence drafted from transaction history",
      "Recovery email history included",
      "Draft, review, approve, submit, every time",
      "No auto-submit toggle, there never has been one",
      `${pct(DISPUTE_FEE_BPS)} only when Foxhound wins, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    ],
  },
  {
    id: "intelligence",
    name: "Intelligence",
    price: usd(INTELLIGENCE_PRICE_CENTS),
    priceLabel: "per month for predictive risk scoring",
    description: `${INTELLIGENCE_FREE_TIER_SENTENCE} Predictive risk scoring is the paid layer.`,
    features: [
      "MRR, movements, churn, cohorts: free for Recovery merchants",
      `Predictive risk scoring: the paid ${usd(INTELLIGENCE_PRICE_CENTS)}/mo layer`,
      // Recova's "Health signals feed Recovery timing and Disputes triage" is
      // removed: Recovery's schedule comes from the decline category alone and
      // Disputes computes no triage (APPROVED-DIFFERENCES, Intelligence entry).
      "Account-wide, not per-customer",
      // 377(8): the annual term comes off the page until a checkout exists. An
      // offer with no way to accept it fails the FTC's bona fide test whatever
      // the intent behind it, and nothing in the billing run can sell or invoice
      // an annual term today: run.ts emits recovery_fee and dispute_fee lines
      // only. PRICING rev 3's 10-month term is unchanged and returns the day a
      // purchase path ships. The price figure is untouched.
      "Granted during early access; ask us",
    ],
  },
];

export interface PricingFaq {
  question: string;
  answer: string;
}

// Recova has three; the third here, "When am I actually billed?", is ratified
// (Dustin, 2026-07-28, m4.txt): it discloses the maturity window.
export const PRICING_FAQS: PricingFaq[] = [
  {
    question: "Is there a free trial?",
    answer:
      "Audit is always free with no account required. Recovery and Disputes have no trial period because they only charge on outcomes, so there is no upfront cost. If Foxhound doesn't recover anything, you pay nothing.",
  },
  {
    question: 'What counts as a "recovered" payment?',
    answer: `A payment is recovered when a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged, or a card was updated through a Foxhound page. A click counts only if it came within ${EMAIL_ENGAGEMENT_WINDOW_DAYS} days before the payment, and a click Foxhound marks suspect, such as one from a mail scanner following links, is shown on the ledger and never billed. Payments Stripe's own Smart Retries recover independently are recorded as free and never billed.`,
  },
  {
    question: "When am I actually billed?",
    answer: `Each monthly run bills the prior month's matured recoveries, meaning recoveries you've held for ${RECOVERY_MATURITY_DAYS} or more days. We never bill a recovery before then.`,
  },
  {
    question: "Can I use multiple products together?",
    answer:
      "Yes. Each product works standalone and its pricing is independent. Used together, Recovery data improves Disputes evidence.",
    // Recova's second clause, "Intelligence signals improve Recovery timing",
    // is removed as untrue (APPROVED-DIFFERENCES, Intelligence entry).
  },
];

export const PRICING_META_DESCRIPTION = `Pay when Foxhound recovers. Baseline recoveries Stripe would have gotten anyway are free. Nothing billed until the recovery has matured for ${RECOVERY_MATURITY_DAYS} days.`;
