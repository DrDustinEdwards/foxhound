import {
  EXPIRING_CARD_DAYS_AHEAD,
  RECOVERY_FEE_BPS,
  RECOVERY_MATURITY_DAYS,
  type DeclineCategory,
} from "~/lib/constants";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";

import {
  countWord,
  DECLINE_CATEGORY_COUNT,
  DECLINE_CATEGORY_COUNT_WORD,
  DECLINE_CATEGORY_COUNT_WORD_LOWER,
  DECLINE_CATEGORY_PHRASE,
  DISTINCT_SEQUENCE_COUNT,
  RECOVERY_SEQUENCE_DAYS,
} from "./decline-categories";

// The /product/recovery copy (J56). Recova's spec is
// app/(marketing)/product/recovery/page.tsx (blob ec4aded8), read whole, and
// this is its copy word for word, with three kinds of change only:
//
// - Branding: Recova becomes Foxhound (RULES.md 1.2).
// - Every product fact is read from Foxhound's engine, never typed (RULES.md
//   2.1): the category count and names from RECOVERY_SCHEDULES, the sequence
//   length from its longest schedule, the fee from RECOVERY_FEE_BPS, the
//   win-back steps and span from WIN_BACK_SCHEDULE, the expiring-card window
//   from EXPIRING_CARD_DAYS_AHEAD.
// - Truthfulness fixes where Recova's words describe something Foxhound does
//   not do (RULES.md 1.2). Each is named beside its string below.
//
// Every one of these is listed in the J56 PR notes for the seat to read.

const pct = `${RECOVERY_FEE_BPS / 100}%`;

const WINBACK_STEPS = WIN_BACK_SCHEDULE.length;
const WINBACK_DAYS = Math.round(WIN_BACK_SCHEDULE[WIN_BACK_SCHEDULE.length - 1].offsetHours / 24);

/** The short word on each category's pill, as Recova's CategoryPill has one
 *  ("Soft", "Network", "Expired", "Fraud"). A Record over DeclineCategory, so a
 *  seventh category does not compile until it has its word. */
export const CATEGORY_PILL_WORDS: Record<DeclineCategory, string> = {
  soft: "Soft",
  network: "Network",
  expired: "Expired",
  fraud: "Fraud",
  revoked: "Revoked",
  unknown: "Unclassified",
};

export const RECOVERY_META_DESCRIPTION = `Up to ${RECOVERY_SEQUENCE_DAYS}-day AI recovery sequences across ${DECLINE_CATEGORY_COUNT} decline categories. ${pct} of what Foxhound recovers, nothing before that.`;

export const RECOVERY_HERO = {
  // Truthfulness: Recova reads "of what you recover". Foxhound bills only the
  // recoveries it attributes to its own action; Stripe-baseline recoveries are
  // free (PRICING.md; app/lib/billing/billable-predicates.ts).
  headline: `${pct} of what Foxhound recovers.\nNothing before that.`,
  // Consistency: Recova reads "Four decline categories handled with different
  // sequences". Foxhound's expired and unknown share one schedule, so the
  // sequence count is named, as block 1's title names it.
  sub: `AI-written email sequences and card network retries across ${RECOVERY_SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories handled with ${countWord(DISTINCT_SEQUENCE_COUNT).toLowerCase()} different sequences. You pay only when Foxhound recovers a payment.`,
  // Truthfulness: Recova reads "of recovered revenue"; see the headline.
  pricing: `${pct} of Foxhound-attributed recoveries · No monthly fee · Invoiced monthly`,
};

export const RECOVERY_STEPS = [
  {
    title: "Payment fails on Stripe",
    body: `Foxhound receives the webhook within seconds. The decline code is classified into one of ${DECLINE_CATEGORY_COUNT_WORD_LOWER} categories: ${DECLINE_CATEGORY_PHRASE}.`,
  },
  {
    title: "Foxhound starts a sequence",
    // Truthfulness: Recova opens with the email and times it "to card network
    // retry windows". Foxhound retries silently before the first email where
    // the decline allows a retry (APPROVED-DIFFERENCES, "Silent retry comes
    // before the first email", 2026-08-01), and its step timings are fixed
    // offsets with no card-network timing behind them (app/lib/constants.ts).
    body: `Where the decline allows a retry, a silent retry runs first. Then an AI-written email sequence begins. Retry steps attempt the charge directly via Stripe. The sequence runs for up to ${RECOVERY_SEQUENCE_DAYS} days.`,
  },
  {
    title: `You pay ${pct} of what Foxhound recovers`,
    // Truthfulness: Foxhound invoices only attributed recoveries, and only
    // once each has held for the maturity window (PRICING.md).
    body: `At the start of each month, Foxhound invoices ${pct} of the Foxhound-attributed recoveries that have matured for ${RECOVERY_MATURITY_DAYS} days. Nothing owed on sequences that do not recover.`,
  },
];

export const RECOVERY_SECTION_LABEL = "What you see after connecting";

export const RECOVERY_BLOCKS = {
  categories: {
    eyebrow: "Smarter than Smart Retries",
    title: `${DECLINE_CATEGORY_COUNT_WORD} categories. ${countWord(DISTINCT_SEQUENCE_COUNT)} different sequences.`,
    // Split around the Smart Retries link Recova embeds in this paragraph.
    bodyBefore: "Stripe's",
    linkText: "Smart Retries",
    linkHref: "https://stripe.com/docs/billing/revenue-recovery/smart-retries",
    // Truthfulness: Foxhound classifies into its engine's categories, two of
    // which share one schedule, and a soft decline's retries are not timed to
    // card network windows (see the second step above).
    bodyAfter: `treat all declines the same. Foxhound classifies every decline code, ${DECLINE_CATEGORY_PHRASE}, and runs the sequence set for its category. A fraud decline gets no retry steps. An expired card gets emails focused on updating payment info. A soft decline gets a silent retry first, then both emails and retries.`,
  },
  dashboard: {
    eyebrow: "Full visibility",
    title: "Every payment. Every step. Every timestamp.",
    body: "The recovery dashboard shows recovered revenue, MRR at risk, recovery rate, the ROI breakdown, and each active payment with its sequence progress. Every step, scheduled, sent, pending, has exact timestamps and results. Email previews visible on every completed step.",
  },
  payments: {
    eyebrow: "What you see after connecting",
    title: "Your failed payments, classified and in sequence.",
    body: "Every failed invoice appears in the payments table with the customer, amount, decline category and code, sequence progress, status, and detection date. Filter by status, search by customer, export to CSV.",
  },
};

export const RECOVERY_PRICING = {
  price: pct,
  // Truthfulness: see the hero's headline.
  priceLabel: "of Foxhound-attributed recoveries, invoiced monthly",
  points: [
    "No monthly fee, you pay nothing until Foxhound recovers a payment",
    `Up to ${RECOVERY_SEQUENCE_DAYS}-day sequences across ${DECLINE_CATEGORY_COUNT} decline categories`,
    // Truthfulness: Recova's "Haiku quality audit pass" names a model and an
    // AI audit. Foxhound's gate (passesQualityGate, app/lib/recovery/
    // email-generation.ts) is a deterministic brand-voice check.
    "AI-written emails with a quality check pass",
    // Truthfulness: no card-network timing (see the second step).
    "Retry timing per decline category",
    `Win-back sequences on cancellation (${WINBACK_STEPS} steps over ${WINBACK_DAYS} days)`,
    `Expiring card alerts (daily, ${EXPIRING_CARD_DAYS_AHEAD}-day window)`,
    "Open and click tracking per email step",
    // Recova's "Custom email body override per step" is left out: the email
    // body editor is not built (APPROVED-DIFFERENCES, "confirmed", 2026-08-15;
    // RULES.md 5.6).
    "Unlimited Stripe accounts at the same per-account rate",
  ],
};

export const RECOVERY_FAQS = [
  {
    q: "What counts as a recovered payment?",
    a: "A payment is recovered when Foxhound's sequence results in the invoice being paid. Attribution is tracked per step. Payments that Stripe's Smart Retries recover independently are not counted as Foxhound recoveries.",
  },
  {
    q: "What happens if a customer replies to a recovery email?",
    // Recova's words (product/recovery/page.tsx), with one truthfulness fix:
    // Recova's "your notification email, the one set in Recova settings".
    // Foxhound sets the Reply-To from the connection's reply_to_email
    // (Settings, Email; due-steps.ts and send.ts), not the notification email,
    // and with none set a reply goes to the From address.
    a: "Replies go to your reply-to email, the one set in Foxhound settings. Foxhound sends with your brand name, so replies come back to you. Until you set one, replies go to the address in the From line.",
  },
  {
    q: "Can I pause or cancel a sequence?",
    // Truthfulness: Foxhound's payment detail page offers Stop recovery,
    // Trigger next step now, Mark as recovered and Resend last email. It has
    // no pause, resume or step override.
    a: "You can stop one. From the payment detail page you can stop recovery on any active sequence, or trigger the next step at any time. Pausing and resuming a sequence is not built yet.",
  },
];

export const RECOVERY_BOTTOM_CTA = {
  title: "See what is currently unrecovered.",
  sub: "The free audit shows your failed invoices and estimates what recovery sequences would return.",
  note: "No account required · Read-only Stripe access · Takes 30 seconds",
};
