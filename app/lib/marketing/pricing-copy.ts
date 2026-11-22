import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  DISPUTE_FEE_CAP_CENTS,
  EMAIL_ENGAGEMENT_WINDOW_DAYS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  countWord,
  DISTINCT_SEQUENCE_COUNT,
  RECOVERY_SEQUENCE_DAYS,
} from "~/lib/marketing/decline-categories";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

import type { ProductKey } from "./products";

// /pricing's card, FAQ and meta copy, out of the route so tests can import it. The wording is frozen for the claims pass; every
// number is read from the engine constants, never typed (the Recovery bullet reads DECLINE_CATEGORY_COUNT, as the card
// description does).

const usd = (cents: number) => formatMoneyShort(cents, "usd");

export interface PricingCard {
  id: ProductKey;
  name: string;
  price: string;
  priceLabel?: string;
  description: string;
  features: string[];
}

// Audit first: the free, no-signup entry point.
/** Intelligence is free on every account, in the words every page uses (here, the home page and /product/intelligence). */
export const INTELLIGENCE_FREE_SENTENCE =
  "Intelligence is free for every Foxhound account, with nothing to subscribe to.";

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
    price: `${RECOVERY_FEE_PERCENT}%`,
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
    price: `${DISPUTE_FEE_PERCENT}%`,
    priceLabel: `of won disputes, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    description:
      "Evidence drafted from your Stripe data and recovery history. You approve every submission, or turn on auto-submit.",
    features: [
      "Evidence drafted from transaction history",
      "Recovery email history included",
      "Draft, review, approve, submit, every time",
      "Auto-submit before deadline, off by default",
      `${DISPUTE_FEE_PERCENT}% only when Foxhound wins, capped at ${usd(DISPUTE_FEE_CAP_CENTS)}`,
    ],
  },
  {
    id: "intelligence",
    name: "Intelligence",
    price: "Free",
    description: `Customer health scoring, churn prediction, and MRR trend analysis. ${INTELLIGENCE_FREE_SENTENCE}`,
    features: [
      "MRR, movements, churn, and cohorts",
      "Health scores, churn risk, alerts, and a nightly plain-English summary",
      // "Health signals feed Recovery timing and Disputes triage" is removed: failed-payment retries and emails follow the decline
      // category alone, Disputes computes no triage (APPROVED-DIFFERENCES, Intelligence entry), and the one timing Intelligence changes,
      // win-back step 1, is a delay (winback-copy.ts).
      "Every account, no subscription",
    ],
  },
];

export interface PricingFaq {
  question: string;
  answer: string;
}

// The third, "When am I actually billed?", is ratified (m4.txt): it discloses the maturity window.
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
    // "Intelligence signals improve Recovery timing" is removed as untrue (APPROVED-DIFFERENCES, Intelligence entry).
  },
];

export const PRICING_META_DESCRIPTION = `Pay when Foxhound recovers. Baseline recoveries Stripe would have made anyway are free. Nothing billed until one has matured for ${RECOVERY_MATURITY_DAYS} days.`;
