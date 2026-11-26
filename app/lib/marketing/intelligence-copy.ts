import { formatCount } from "@drdustinedwards/site-helpers/text";
import { INTELLIGENCE_MAX_CUSTOMERS_SCANNED, INTELLIGENCE_NARRATIVE_TOP_N } from "~/lib/constants";
import {
  HEALTH_SCORE_BASELINE,
  HEALTH_SIGNAL_LABELS,
  type HealthSignal,
} from "~/lib/intelligence/risk";
import { countWord, DECLINE_CATEGORY_COUNT } from "~/lib/marketing/decline-categories";
import { INTELLIGENCE_FREE_SENTENCE } from "~/lib/marketing/pricing-copy";
import { INTELLIGENCE_WINBACK_SENTENCE } from "~/lib/marketing/winback-copy";
import { listText } from "capsomer/behavior/hooks";

// The /product/intelligence copy. Every product fact is read from Foxhound's engine, never typed: the score's signals and
// baseline from risk.ts, the customer cap from INTELLIGENCE_MAX_CUSTOMERS_SCANNED, the narrative's reach from
// INTELLIGENCE_NARRATIVE_TOP_N, the decline categories from RECOVERY_SCHEDULES. Where a sentence would claim more than the
// engine does, the reason is beside the string. The recurring ones: the score moves from a baseline with six signals
// (risk.ts); recommended actions are four rules (recommend.ts) and none changes a sequence's timing; MRR snapshots and
// scores are daily; Intelligence changes no failed-payment retry or email and computes no dispute triage, though it
// delays the first win-back email (winback-copy.ts); Intelligence is free on every account (INTELLIGENCE_FREE_SENTENCE);
// the narrative is a template with no model call, so no line says AI.

const customerCap = formatCount(INTELLIGENCE_MAX_CUSTOMERS_SCANNED);
const labels: string[] = Object.values(HEALTH_SIGNAL_LABELS);
const signalCount = countWord(labels.length);
const signalList = listText(labels);

/** Each signal as the score FAQ explains it, keyed by the engine's signals, so a new signal does not compile until its words are written. */
const SIGNAL_EXPLAINED: Record<HealthSignal, (label: string) => string> = {
  payment_latency: (l) => `${l} (payments drifting later or earlier against their due date)`,
  billing_volatility: (l) =>
    `${l} (plan, interval, and seat changes on record, and a scheduled cancellation, paused billing, or downgrade as Stripe reports it)`,
  refunds_disputes: (l) => `${l} on record`,
  recovery_engagement: (l) => `${l} (whether the customer engaged with recovery emails)`,
  tenure: (l) => l,
  payment_method: (l) => `${l} (a prepaid card on the latest failed payment)`,
};
const signalsExplained = listText(
  (Object.keys(HEALTH_SIGNAL_LABELS) as HealthSignal[]).map((k) =>
    SIGNAL_EXPLAINED[k](HEALTH_SIGNAL_LABELS[k]),
  ),
);

export const INTELLIGENCE_META_DESCRIPTION =
  "Customer health scoring, churn prediction, and MRR trend analysis for Stripe merchants. Free.";

export const INTELLIGENCE_HERO = {
  headline: "Know which customers are about to churn.\nBefore they do.",
  // The signals are risk.ts's and the rules produce four actions; the price is free and the pricing line says so.
  sub: `0-100 health scores per customer, derived from ${signalList}. Four recommended actions. Daily MRR tracking with NRR and churn rate trends.`,
  pricing: "Free · No subscription · Account-wide",
};

export const INTELLIGENCE_STEPS = [
  {
    title: "Intelligence scores every customer nightly",
    // Foxhound's signals are risk.ts's, a sync reads up to INTELLIGENCE_MAX_CUSTOMERS_SCANNED customers, and the narrative
    // assesses the INTELLIGENCE_NARRATIVE_TOP_N most at risk (narrativeFactsFor), from a template, not a model (narrative.ts).
    body: `${signalCount} signals, ${signalList}, combine into a 0-100 health score for every customer Foxhound reads from Stripe, up to ${customerCap} per account. Each night a plain-English assessment is written for each of the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers, from the signals that moved its score.`,
  },
  {
    // Four actions are recommend.ts's; the two that ask for you are the Recommendations page's sections (app/routes/app/intelligence/recommendations.tsx).
    title: "Four recommended actions surface",
    body: "Personal outreach for high-value customers showing risk. Continue automated where the automated flow is enough, with high-value customers flagged to watch closely. Each recommendation is actionable.",
  },
  {
    // intelligence-sync runs daily, and the dashboard sums movement by week.
    title: "MRR data updates daily",
    body: "New, expansion, reactivation, contraction, and churn MRR tracked week by week. NRR and GRR computed from Stripe subscription data. No manual data entry.",
  },
];

export const INTELLIGENCE_SECTION_LABEL = "What you see after connecting";

/** The three feature blocks. The first takes the preview's active-customer figure. */
export function intelligenceBlocks(activeCustomers: string) {
  return {
    dashboard: {
      title: "MRR trends, plan breakdown, monthly narrative.",
      // The narrative is on the dashboard, not the weekly digest; no plan is named because a merchant's plans are their own.
      body: `MRR tracked across ${activeCustomers} active customers. Per-plan breakdown with bar proportions. Monthly narrative summarizing what happened and what to watch, on the dashboard. Day-over-day MRR delta shown on every load.`,
    },
    score: {
      // The score ranks; the recommended action comes from the recommend.ts rules, not from the score.
      title: "A score that tells you where to look.",
      // On the customer page each signal that moved the score is listed with its points (customer.tsx).
      body: `The health score is derived from ${signalCount.toLowerCase()} independent signals: ${signalList}. The score is not a black box, every signal that moved it is shown separately. Customers sorted by health score ascending so worst-health customers surface first.`,
    },
    churn: {
      title: "See your at-risk MRR by band.",
      body: "The Churn page distributes your MRR across three health bands, high risk, medium, and healthy. High-risk customers are sorted by MRR contribution descending so your highest-value at-risk customers surface first.",
    },
  };
}

export const INTELLIGENCE_PRICING = {
  price: "Free",
  priceLabel: INTELLIGENCE_FREE_SENTENCE,
  points: [
    `Health scores for every Stripe customer, up to ${customerCap} per account, updated nightly`,
    "Four recommendation types, actionable, not just labels",
    `Nightly plain-English assessment for the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers`,
    // GRR is computed but drawn nowhere, so it is not ticked.
    "Daily MRR snapshots with NRR and movement waterfall",
    "Per-plan breakdown from Stripe subscription data",
    "Churn risk page with MRR by health band",
    // The customer page has no timeline (customer.tsx), so none is claimed.
    "Monthly narrative report on the dashboard",
    // Signals feeding Recovery timing and Disputes triage are left out: neither exists.
  ],
};

export const INTELLIGENCE_FAQS = [
  {
    question: "How is the health score calculated?",
    // Risk.ts's signals and baseline are the score; each factor that moved it is listed on the customer page with its points.
    answer: `${signalCount} signals move the 0-100 score up or down from a baseline of ${HEALTH_SCORE_BASELINE}: ${signalsExplained}. Each signal that moved the score is shown separately, with its points, on the customer detail page.`,
  },
  {
    question: "Does Intelligence affect my Recovery sequences?",
    // Foxhound has no deprioritize delay and computes no dispute triage: failed-payment RECOVERY_SCHEDULES are keyed on decline
    // category alone. It does keep the win-back gate (process.ts resolveWinbackStep1Offset), which delays win-back step 1 for
    // every customer not flagged winback_priority, so the answer says so (winback-copy.ts).
    answer: `Not for failed payments. Retries and recovery emails follow the decline category alone, one schedule for each of the ${countWord(DECLINE_CATEGORY_COUNT).toLowerCase()} decline categories, the same for every customer, and Intelligence scores no dispute. One timing does change. ${INTELLIGENCE_WINBACK_SENTENCE}`,
  },
  {
    question: "What is the difference between Intelligence and the free Audit?",
    answer:
      "The Audit is a one-time diagnostic snapshot of your Stripe account. Intelligence is a continuous nightly scoring system that tracks customer health over time, surfaces actionable recommendations, and tracks MRR trends. The Audit is a starting point. Intelligence is an ongoing operational layer.",
  },
];

export const INTELLIGENCE_BOTTOM_CTA = {
  title: "Your highest-value customers are telling you they are at risk.",
  sub: "Intelligence surfaces them before they churn.",
};
