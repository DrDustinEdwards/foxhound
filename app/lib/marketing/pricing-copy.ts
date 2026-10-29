import {
  DISPUTE_FEE_BPS,
  DISPUTE_FEE_CAP_CENTS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  countWord,
  DISTINCT_SEQUENCE_COUNT,
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
/** Intelligence is free on every account (Dustin, 2026-10-29), in the words
 *  every page uses (here, the home page and /product/intelligence), so the site
 *  says one thing. */
export const INTELLIGENCE_FREE_SENTENCE = "Intelligence is free for every Foxhound account, with nothing to subscribe to.";

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
    description: `AI-drafted email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${countWord(DISTINCT_SEQUENCE_COUNT).toLowerCase()} different sequences.`,
    features: [
      "Silent retry before any customer email, wherever the decline can be retried",
      `Up to ${RECOVERY_SEQUENCE_DAYS}-day sequences across ${DECLINE_CATEGORY_COUNT} decline categories`,
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
    price: "Free",
    description: `Customer health scoring, churn prediction, and MRR trend analysis. ${INTELLIGENCE_FREE_SENTENCE}`,
    features: [
      "MRR, movements, churn, and cohorts",
      "Health scores, churn risk, alerts, and the nightly AI analyst",
      // Recova's "Health signals feed Recovery timing and Disputes triage" is
      // removed: failed-payment retries and emails follow the decline category
      // alone, Disputes computes no triage (APPROVED-DIFFERENCES, Intelligence
      // entry), and the one timing Intelligence does change, win-back step 1,
      // is a delay, not an improvement (winback-copy.ts).
      "Every account, no subscription",
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
