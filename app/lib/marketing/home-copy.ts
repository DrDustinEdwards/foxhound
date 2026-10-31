import {
  DISPUTE_FEE_BPS,
  DISPUTE_FEE_CAP_CENTS,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
} from "~/lib/constants";
import {
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_LIST_AND,
  DISTINCT_SEQUENCE_COUNT,
  RECOVERY_SEQUENCE_DAYS,
  countWord,
} from "~/lib/marketing/decline-categories";
import { STAT_SOURCES, STRIPE_RECOVERY_RATE_PERCENT, STRIPE_UNRECOVERED_RATE_PERCENT } from "~/lib/marketing/statistics";
import { formatMoneyShort } from "~/lib/money-format";

import type { ProductKey } from "./products";

// The home page's copy, out of the route so tests and the JSON-LD
// read one source. Recova's spec is app/(marketing)/page.tsx (blob c10db7d5),
// read whole at HEAD.
//
// RECOVA'S WORDS, EXCEPT WHERE RECOVA WAS FALSE. The copy-drift items of
// parity/M3-DIVERGENCES.md (1b, 4, 6, 7, 21, 25, 26, 27, 30, 50, and the
// how-it-works links of 9b) move back to Recova's wording. The sanctioned
// truthfulness divergences (read and write scope, review-and-sign disputes,
// baseline free, 30-day maturity, no Multi-account, attribution language) stay.
// Every product fact is read from the engine, never typed: the
// fee, the cap, the price, the maturity window, the sequence length, the
// decline categories and the Stripe statistic.
//
// Where Recova's sentence states something Foxhound's engine does not do, the
// fix is named beside the string. Each is listed under Needs Dustin in the PR.

const pct = (bps: number) => `${bps / 100}%`;
const usd = (cents: number) => formatMoneyShort(cents, "usd");

export const RECOVERY_FEE = pct(RECOVERY_FEE_BPS);
const DISPUTE_FEE = pct(DISPUTE_FEE_BPS);
const DISPUTE_CAP = usd(DISPUTE_FEE_CAP_CENTS);
export const MATURITY_DAYS = RECOVERY_MATURITY_DAYS;
export const SEQUENCE_DAYS = RECOVERY_SEQUENCE_DAYS;
const STRIPE_RATE = `${STRIPE_RECOVERY_RATE_PERCENT}%`;
export const STRIPE_GAP = `${STRIPE_UNRECOVERED_RATE_PERCENT}%`;

/** Recova's title, "Recova: Recover failed Stripe payments", in Foxhound's name (divergence 50). */
export const HOME_TITLE = "Foxhound: Recover failed Stripe payments";

/** Recova's description. Two truthfulness fixes: Foxhound drafts dispute
 *  evidence and the merchant signs it (Recova said automation), and nothing is
 *  billed until a recovery has matured (Recova said "until then"). */
export const HOME_META_DESCRIPTION = `Foxhound recovers failed Stripe payments, builds dispute evidence you sign, and adds customer intelligence. You pay ${RECOVERY_FEE} of what it recovers, after ${MATURITY_DAYS} days.`;

/** Recova's first five hero sentences, word for word in Foxhound's name. */
export const HERO_LEAD =
  "Most churn is not people quitting. It is cards that fail. Foxhound gets that revenue back. Stripe takes the payment. Foxhound wins back the ones that fail.";

/** The trust row. Item 1 is Recova's; items 2 and 3 are the sanctioned
 *  baseline-free and maturity facts (divergence 22); item 4 is Recova's. */
export const TRUST_ITEMS = [
  "Baseline recoveries are free",
  `No fee until ${MATURITY_DAYS}-day maturity`,
  "Disconnect anytime",
];

export interface HomeStat {
  stat: string;
  body: string;
  /** The exact page; the citation shows it without its scheme. */
  href: string;
}

/** A cited page as the citation shows it: the address without https://. */
export const citation = (href: string) => href.replace(/^https:\/\//, "");

/** Recova's three statistics, each with its exact page. The first
 *  is Stripe's own rate, read from lib/marketing/statistics.ts. "failed
 *  payments" rather than Recova's "failed recurring payments" is the source's
 *  own wording. */
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
    // Recova: "AI-written emails timed to card network windows. Decline
    // classification by soft, network, expired, and fraud, each handled with a
    // different sequence." The engine classifies into the categories
    // RECOVERY_SCHEDULES names, two of them share one schedule, and only the
    // retryable ones get a silent retry, ahead of the first email.
    foxhoundBody: `AI-written emails, with a silent retry ahead of the first email wherever the decline can be retried. Decline classification by ${DECLINE_CATEGORY_LIST_AND}, each handled by its category's own schedule.`,
    foxhoundHref: "/product/recovery",
  },
  {
    stripeTitle: "Dispute notifications",
    stripeBody:
      "Stripe emails you when a dispute opens and shows you a deadline. Evidence submission, response writing, and Stripe submission are all manual.",
    // Sanctioned (divergence 5): Recova's "Automated dispute responses" and
    // "Auto-submitted before the deadline"; the merchant signs, and auto-submit
    // is an opt-in that is off by default.
    foxhoundTitle: "Evidence drafted, you review and sign",
    foxhoundBody: `Evidence built from your recovery history, Stripe signals, and transaction data. You review and sign every submission before the deadline. ${DISPUTE_FEE} only when you win, capped at ${DISPUTE_CAP}.`,
    foxhoundHref: "/product/disputes",
  },
];

/** The statement section's body, Recova's, with the numbers read from the engine. */
export const STATEMENT_BODY = `Stripe's Smart Retries recover ${STRIPE_RATE} on average. The other ${STRIPE_GAP} needs something Stripe doesn't do: personalized email sequences, decline classification, and ${SEQUENCE_DAYS} days of follow-through.`;

export interface HomeProductCard {
  description: string;
  price: string;
}

/** Recova's four product cards. Audit is Recova's word for word. Recovery is
 *  Recova's with the engine's counts: it schedules more categories than
 *  sequences, so it says both rather than "handled differently". Disputes is
 *  the sanctioned review-and-sign wording (divergence 16). Intelligence keeps
 *  Recova's three features and is free (Dustin, 2026-10-29), in /pricing's words. */
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
    description: "Evidence drafted for every dispute. You review and sign every submission before it reaches Stripe.",
    price: `${DISPUTE_FEE} of won disputes, capped at ${DISPUTE_CAP}`,
  },
  intelligence: {
    description: "Customer health scoring, churn prediction, and MRR trend analysis.",
    price: "Free",
  },
};

export interface HomeFaq {
  question: string;
  /** Plain text: the source for the FAQPage JSON-LD, as Recova's answer is. */
  answer: string;
}

/** Recova's five questions. FAQ 1 is the sanctioned read-and-write answer,
 * FAQ 2 the sanctioned billable-recovery definition, FAQ 3 the
 *  sanctioned maturity and cap timing in Recova's question and Recova's closing
 *  sentence, FAQ 4 the 376 item 19 fix and FAQ 5 Recova's with the maturity
 *  qualifier. FAQ 3's answer is drawn with Recova's four product links in the
 *  route; this plain text is the same sentence. */
export const FAQS: HomeFaq[] = [
  {
    question: "Does Foxhound touch my Stripe billing configuration?",
    answer:
      "No. The connection carries read and write scope, because retrying a failed invoice is a write, but Foxhound writes for these things and no others: retrying an invoice that has already failed, setting a customer default payment method after that customer updates their card, opening a Stripe checkout when a former customer chooses to resubscribe, submitting dispute evidence you approved, and closing a dispute at Stripe when you choose to accept it. It never changes your prices, products, subscription plans, or any other Stripe setting, and never reaches your payouts.",
  },
  {
    question: "What counts as a recovery Foxhound can bill for?",
    answer:
      "Only recoveries where a Foxhound action provably preceded payment: a scheduled retry succeeded, a dunning email was clicked or otherwise engaged (not just opened), or a card was updated through a Foxhound page. Anything Stripe recovers on its own is recorded and shown to you as free, never billed.",
  },
  {
    question: "How does billing work exactly?",
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

/** The FAQ 3 answer in its linked form: text runs and the four product links,
 *  in Recova's places (the product names). Joined, it is FAQS[2].answer. */
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

/** Recova's security chips. Chip 1 is the sanctioned replacement of "Read-only
 *  Stripe access" (divergence 24); chip 5 replaces "US-based · US servers",
 *  because Foxhound runs on Cloudflare's global network, not on US servers. */
export const SECURITY_CHIPS = [
  "Never touches your billing configuration",
  "No card data stored",
  "AES-256 encryption",
  "CAN-SPAM compliant",
  "US company, US jurisdiction",
];

/** Recova's compatibility line, without Multi-account (divergence 40). */
export const COMPAT_TAGS = ["Stripe Billing", "Stripe Checkout", "Custom invoices", "Stripe Subscriptions"];
