import { STRIPE_WRITES, STRIPE_WRITES_LIMITS } from "~/lib/marketing/trust-copy";
import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS, RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_LIST_AND,
  DISTINCT_SEQUENCE_COUNT,
  RECOVERY_SEQUENCE_DAYS,
  countWord,
} from "~/lib/marketing/decline-categories";
import {
  STAT_SOURCES,
  STRIPE_RECOVERY_RATE_PERCENT,
  STRIPE_UNRECOVERED_RATE_PERCENT,
} from "~/lib/marketing/statistics";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

import type { ProductKey } from "./products";

// The home page's copy, out of the route so tests and the JSON-LD read one source. Every product fact is read from the
// engine, never typed: the fee, the cap, the price, the maturity window, the sequence length, the decline categories and the
// Stripe statistic. Where a sentence would claim more than the engine does, the fix is beside the string (read and write
// scope, review-and-sign disputes, baseline free, 30-day maturity, attribution language).

const usd = (cents: number) => formatMoneyShort(cents, "usd");

export const RECOVERY_FEE = `${RECOVERY_FEE_PERCENT}%`;
const DISPUTE_FEE = `${DISPUTE_FEE_PERCENT}%`;
const DISPUTE_CAP = usd(DISPUTE_FEE_CAP_CENTS);
export const MATURITY_DAYS = RECOVERY_MATURITY_DAYS;
export const SEQUENCE_DAYS = RECOVERY_SEQUENCE_DAYS;
const STRIPE_RATE = `${STRIPE_RECOVERY_RATE_PERCENT}%`;
export const STRIPE_GAP = `${STRIPE_UNRECOVERED_RATE_PERCENT}%`;

export const HOME_TITLE = "Foxhound: Recover failed Stripe payments";

/** Dispute evidence is drafted and the merchant signs it; nothing is billed until a recovery has matured. */
export const HOME_META_DESCRIPTION = `Foxhound recovers failed Stripe payments, builds dispute evidence you sign, and adds customer intelligence. You pay ${RECOVERY_FEE} of what it recovers, after ${MATURITY_DAYS} days.`;

export const HERO_LEAD =
  "Most churn is not people quitting. It is cards that fail. Foxhound gets that revenue back. Stripe takes the payment. Foxhound wins back the ones that fail.";

/** The trust row: baseline-free and maturity facts included. */
export const TRUST_ITEMS = [
  "Baseline recoveries are free",
  `No fee until ${MATURITY_DAYS}-day maturity`,
  "Disconnect anytime",
];

export interface HomeStat {
  stat: string;
  body: string;
  href: string;
}

export const citation = (href: string) => href.replace(/^https:\/\//, "");

/** Three statistics, each with its exact page. The first is Stripe's own rate (lib/marketing/statistics.ts); "failed
 *  payments" is the source's own wording. */
export const STATS: HomeStat[] = [
  {
    stat: STRIPE_RATE,
    body: `of failed payments are recovered by Stripe's tools on average. The other ${STRIPE_GAP} doesn't come back without additional sequences.`,
    href: STAT_SOURCES.stripeBilling,
  },
  {
    stat: "1 in 4",
    body: "subscription cancellations are purely due to payment failures. These customers never chose to leave, their payment just failed.",
    href: STAT_SOURCES.stripeSmartRetries,
  },
  {
    stat: "7 months",
    body: "is how long recovered subscriptions continue on average. One recovered payment is not one month of revenue, it is most of a year.",
    href: STAT_SOURCES.stripeSmartRetries,
  },
];

export interface ComparisonRow {
  stripeTitle: string;
  stripeBody: string;
  foxhoundTitle: string;
  foxhoundBody: string;
  foxhoundHref: string;
}

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    stripeTitle: "Automatic Smart Retries",
    stripeBody:
      "Fixed retry schedule. No customer communication. No logic for why the payment failed. Soft decline, expired card, and fraud all treated the same.",
    foxhoundTitle: `Intelligent ${SEQUENCE_DAYS}-day sequences`,
    // The engine classifies into the categories RECOVERY_SCHEDULES names, two share one schedule, and only the retryable ones
    // get a silent retry, ahead of the first email.
    foxhoundBody: `AI-written emails, with a silent retry ahead of the first email wherever the decline can be retried. Decline classification by ${DECLINE_CATEGORY_LIST_AND}, each handled by its category's own schedule.`,
    foxhoundHref: "/product/recovery",
  },
  {
    stripeTitle: "Dispute notifications",
    stripeBody:
      "Stripe emails you when a dispute opens and shows you a deadline. Evidence submission, response writing, and Stripe submission are all manual.",
    // The merchant signs; auto-submit is an opt-in that is off by default.
    foxhoundTitle: "Evidence drafted, you review and sign",
    foxhoundBody: `Evidence built from your recovery history, Stripe signals, and transaction data. You approve every submission before the deadline, or turn on auto-submit. ${DISPUTE_FEE} only when you win, capped at ${DISPUTE_CAP}.`,
    foxhoundHref: "/product/disputes",
  },
];

export const STATEMENT_BODY = `Stripe's Smart Retries recover ${STRIPE_RATE} on average. The other ${STRIPE_GAP} needs something Stripe doesn't do: personalized email sequences, decline classification, and ${SEQUENCE_DAYS} days of follow-through.`;

export interface HomeProductCard {
  description: string;
  price: string;
}

/** The four product cards. Recovery uses the engine's counts: more categories than sequences, so it says both. Disputes is
 *  the review-and-sign wording. Intelligence is free, in /pricing's words. */
export const PRODUCT_CARDS: Record<ProductKey, HomeProductCard> = {
  audit: {
    description: "Full Stripe diagnostic. See what is leaking before you commit.",
    price: "Free",
  },
  recovery: {
    description: `AI email sequences and silent retries across ${SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${countWord(DISTINCT_SEQUENCE_COUNT).toLowerCase()} different sequences.`,
    price: `${RECOVERY_FEE} of Foxhound-attributed recoveries`,
  },
  disputes: {
    description:
      "Evidence drafted for every dispute. You approve every submission before it reaches Stripe, or turn on auto-submit.",
    price: `${DISPUTE_FEE} of won disputes, capped at ${DISPUTE_CAP}`,
  },
  intelligence: {
    description: "Customer health scoring, churn prediction, and MRR trend analysis.",
    price: "Free",
  },
};

export const BILLING_FAQ_QUESTION = "How does billing work exactly?";

export interface HomeFaq {
  question: string;
  answer: string;
}

/** The FAQs. The billing answer is drawn with the four product links in the route (BILLING_FAQ_QUESTION); this plain text
 *  is the same sentence. */
export const FAQS: HomeFaq[] = [
  {
    question: "Does Foxhound touch my Stripe billing configuration?",
    answer: `No. The connection carries read and write scope, because retrying a failed invoice is a write, but Foxhound writes for these things and no others: ${STRIPE_WRITES}. It ${STRIPE_WRITES_LIMITS}, and never changes any other Stripe setting.`,
  },
  // Replies go to the merchant's own address through the reply-to setting (app/lib/email/send.ts); until one is saved a reply
  // goes to the From line, as /docs/platform says.
  {
    question: "What happens if a customer replies to a recovery email?",
    answer:
      "It goes to the reply-to address you set in Settings, under Email, so a customer who answers reaches your own inbox, not a no-reply address. Use an inbox somebody reads, because a customer who replies is often trying to fix their payment. Until you set one, replies go to the address in the From line.",
  },
  {
    question: "What counts as a recovery Foxhound can bill for?",
    answer:
      "Only recoveries where a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Anything Stripe recovers on its own is recorded and shown to you as free, never billed.",
  },
  {
    question: BILLING_FAQ_QUESTION,
    answer: `Recovery is ${RECOVERY_FEE} of the prior month's matured recoveries, meaning recoveries you've held for ${MATURITY_DAYS} or more days, billed in each monthly run. Disputes are ${DISPUTE_FEE} of wins only, capped at ${DISPUTE_CAP} per dispute. Intelligence and Audit are always free. You owe nothing for sequences that do not recover.`,
  },
  {
    question: "Can I see what the emails look like before they send?",
    answer:
      "Each email is written at send time from the customer, the decline and your brand voice, so there is no draft sitting there to preview. Every email that goes out is visible in your dashboard afterwards, with click tracking. You set the brand voice that shapes all of them, in one place or per decline category.",
  },
  {
    question: "Can I cancel or pause anytime?",
    answer:
      "Yes. Disconnect Stripe from your settings page and all active sequences stop immediately. No contracts, no minimum commitments. You are billed only for recoveries that already happened and have matured.",
  },
];

/** The billing answer in its linked form: text runs and the four product links. Joined, it is that FAQ's answer. */
export const BILLING_FAQ_PARTS: (string | { to: string; label: string })[] = [
  { to: "/product/recovery", label: "Recovery" },
  ` is ${RECOVERY_FEE} of the prior month's matured recoveries, meaning recoveries you've held for ${MATURITY_DAYS} or more days, billed in each monthly run. `,
  { to: "/product/disputes", label: "Disputes" },
  ` are ${DISPUTE_FEE} of wins only, capped at ${DISPUTE_CAP} per dispute. `,
  { to: "/product/intelligence", label: "Intelligence" },
  " and ",
  { to: "/product/audit", label: "Audit" },
  " are always free. You owe nothing for sequences that do not recover.",
];

/** Security chips. Chip 5 does not say "US servers" because Foxhound runs on Cloudflare's global network. */
export const SECURITY_CHIPS = [
  "Never touches your billing configuration",
  "No card data stored",
  "AES-256 encryption",
  "CAN-SPAM compliant",
  "US company, US jurisdiction",
];
