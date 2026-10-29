import { INTELLIGENCE_MAX_CUSTOMERS_SCANNED, INTELLIGENCE_NARRATIVE_TOP_N } from "~/lib/constants";
import { HEALTH_SCORE_BASELINE, HEALTH_SIGNAL_LABELS, type HealthSignal } from "~/lib/intelligence/risk";
import { countWord, DECLINE_CATEGORY_COUNT } from "~/lib/marketing/decline-categories";
import { INTELLIGENCE_FREE_SENTENCE } from "~/lib/marketing/pricing-copy";
import { INTELLIGENCE_WINBACK_SENTENCE } from "~/lib/marketing/winback-copy";

// The /product/intelligence copy (J58). Recova's spec is
// app/(marketing)/product/intelligence/page.tsx (blob 4f258429), read whole,
// and this is its copy word for word, with three kinds of change only:
//
// - Branding: Recova becomes Foxhound (RULES.md 1.2).
// - Every product fact is read from Foxhound's engine, never typed (RULES.md
//   2.1): the score's signals and
//   baseline from risk.ts, the customer cap from
//   INTELLIGENCE_MAX_CUSTOMERS_SCANNED, the narrative's reach from
//   INTELLIGENCE_NARRATIVE_TOP_N, the decline categories from
//   RECOVERY_SCHEDULES (through decline-categories.ts).
// - Truthfulness fixes where Recova's words describe something Foxhound does
//   not do (RULES.md 1.2). Each is named beside its string below. The ones
//   that recur:
//   * The score. Recova's is three bands (engagement health, recovery history,
//     customer value). Foxhound's moves from a baseline with five signals
//     (risk.ts), and customer value is not one of them.
//   * Recommended actions. Nothing in Foxhound writes one: recommended_action
//     exists only in the demo seed (app/lib/recovery/digest-email.ts records
//     the same finding).
//   * Cadence. MRR snapshots are monthly (intelligence-sync on
//     CRON_SCHEDULE_MONTHLY); scores are nightly (intelligence-ai on
//     CRON_SCHEDULE_DAILY). Recova's MRR was daily and its movements weekly.
//   * Recovery timing and triage on disputes. Intelligence changes no
//     failed-payment retry or email (RECOVERY_SCHEDULES is keyed on decline
//     category alone) and computes no dispute triage (APPROVED-DIFFERENCES,
//     the Intelligence entry). It does delay the first win-back email, legacy's
//     gate in process.ts, and the FAQ says so (winback-copy.ts).
//   * The price. Recova sold Intelligence for $199/mo. Foxhound's is free on
//     every account (Dustin, 2026-10-29), so the hero, the meta description
//     and the pricing card say so in /pricing's words
//     (INTELLIGENCE_FREE_SENTENCE).
//   * The narrative. It is on the dashboard (ai-run.server.ts writes the
//     month's report); the weekly digest lists top at-risk customers, not the
//     narrative (digest-email.ts).
//
// Every one of these is listed in the J58 PR notes for the seat to read.

const customerCap = INTELLIGENCE_MAX_CUSTOMERS_SCANNED.toLocaleString("en-US");
const labels: string[] = Object.values(HEALTH_SIGNAL_LABELS);
const signalCount = countWord(labels.length);
/** "a, b, and c". */
function series(words: string[]): string {
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}
/** "payment timing, billing changes, refunds and disputes, recovery engagement, and tenure". */
const signalList = series(labels);

/** Each signal as the score FAQ explains it, built on the engine's own label.
 *  Keyed by the engine's signals, so a new signal does not compile until its
 *  words are written here. */
const SIGNAL_EXPLAINED: Record<HealthSignal, (label: string) => string> = {
  payment_latency: (l) => `${l} (payments drifting later or earlier against their due date)`,
  billing_volatility: (l) => `${l} (plan, interval, and seat changes on record)`,
  refunds_disputes: (l) => `${l} on record`,
  recovery_engagement: (l) => `${l} (whether the customer engaged with recovery emails)`,
  tenure: (l) => l,
};
const signalsExplained = series(
  (Object.keys(HEALTH_SIGNAL_LABELS) as HealthSignal[]).map((k) => SIGNAL_EXPLAINED[k](HEALTH_SIGNAL_LABELS[k])),
);

export const INTELLIGENCE_META_DESCRIPTION = "Customer health scoring, churn prediction, and MRR trend analysis for Stripe merchants. Free.";

export const INTELLIGENCE_HERO = {
  headline: "Know which customers are about to churn.\nBefore they do.",
  // Truthfulness: Recova reads "derived from engagement signals, recovery
  // history, and customer value. Seven recommended actions. Daily MRR
  // tracking". The signals are risk.ts's, no recommended action is written,
  // and MRR is snapshotted monthly.
  // Recova's "$199/mo flat" closed a sentence about MRR tracking; the price is
  // free now and the pricing line under the sub says so.
  sub: `0-100 health scores per customer, derived from ${signalList}. Monthly MRR tracking with NRR and churn rate trends.`,
  pricing: "Free · No subscription · Account-wide",
};

export const INTELLIGENCE_STEPS = [
  {
    title: "Intelligence scores every customer nightly",
    // Truthfulness: Recova reads "Three health bands, engagement health,
    // recovery history, and customer value, combine into a 0-100 health
    // score. The nightly AI analyst writes a plain-English assessment for
    // every at-risk customer." Foxhound's signals are risk.ts's, a sync reads
    // up to INTELLIGENCE_MAX_CUSTOMERS_SCANNED customers, and the narrative
    // assesses the INTELLIGENCE_NARRATIVE_TOP_N most at risk (narrativeFactsFor).
    body: `${signalCount} signals, ${signalList}, combine into a 0-100 health score for every customer Foxhound reads from Stripe, up to ${customerCap} per account. The nightly AI analyst writes a plain-English assessment for each of the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers.`,
  },
  {
    // Truthfulness: Recova reads "Seven recommended actions surface" and lists
    // personal outreach, continue automated and win-back priority. Nothing
    // writes a recommendation, so the step says what Foxhound does: the
    // directory sorts by health ascending and the churn page ranks the
    // high-risk band by MRR (views.server.ts).
    title: "High-value customers at risk surface first",
    body: "Customers are sorted by health score, lowest first, and the churn page ranks the high-risk band by MRR, so your highest-value customers showing risk are at the top. A recommended action per customer is not built yet.",
  },
  {
    // Truthfulness: Recova reads "MRR data updates daily" and "tracked week by
    // week". intelligence-sync runs monthly.
    title: "MRR data updates monthly",
    body: "New, expansion, reactivation, contraction, and churn MRR tracked month by month. NRR and GRR computed from Stripe subscription data. No manual data entry.",
  },
];

export const INTELLIGENCE_SECTION_LABEL = "What you see after connecting";

/** The three feature blocks. The first names the demo's active customers, so
 *  it takes the preview's figure rather than Recova's typed 185. */
export function intelligenceBlocks(activeCustomers: string) {
  return {
    dashboard: {
      // Truthfulness: Recova reads "Daily from Stripe".
      eyebrow: "Monthly from Stripe",
      title: "MRR trends, plan breakdown, monthly narrative.",
      // Truthfulness: Recova's narrative is "delivered in the weekly digest"
      // and its "Day-over-day MRR delta shown on every load". Foxhound's
      // narrative is on the dashboard, and the dashboard says the day-over-day
      // change is not computed (app/routes/app/intelligence/index.tsx).
      // Recova names its demo's plans ("Starter, Growth, and Scale"); a
      // merchant's plans are their own, so no plan is named.
      body: `MRR tracked across ${activeCustomers} active customers. Per-plan breakdown with bar proportions. Monthly AI narrative summarizing what happened and what to watch, on the dashboard. A day-over-day MRR change is not computed, because MRR is snapshotted monthly.`,
    },
    score: {
      eyebrow: "0-100 per customer",
      // Truthfulness: Recova reads "A score that tells you what to do." The
      // score recommends no action (see above); it ranks.
      title: "A score that tells you where to look.",
      // Truthfulness: the signals, as above; on the customer page each signal
      // that moved the score is listed with its points (customer.tsx).
      body: `The health score is derived from ${signalCount.toLowerCase()} independent signals: ${signalList}. The score is not a black box, every signal that moved it is shown separately. Customers sorted by health score ascending so worst-health customers surface first.`,
    },
    churn: {
      eyebrow: "MRR at risk",
      title: "See your at-risk MRR by band.",
      body: "The Churn page distributes your MRR across three health bands, high risk, medium, and healthy. High-risk customers are sorted by MRR contribution descending so your highest-value at-risk customers surface first.",
    },
  };
}

export const INTELLIGENCE_PRICING = {
  price: "Free",
  priceLabel: INTELLIGENCE_FREE_SENTENCE,
  points: [
    // Truthfulness: the sync's customer cap.
    `Health scores for every Stripe customer, up to ${customerCap} per account, updated nightly`,
    // Recova's "Seven recommendation types, actionable, not just labels" is
    // left out: nothing writes a recommendation, and a ticked line would claim it.
    // Truthfulness: Recova reads "per at-risk customer".
    `Nightly AI analyst plain-English assessment for the ${INTELLIGENCE_NARRATIVE_TOP_N} most at-risk customers`,
    // Recova's "Daily MRR snapshots with NRR, GRR, and movement waterfall" and
    // "Per-plan breakdown from Stripe subscription data": the NRR chart and MRR
    // by plan are on the Intelligence dashboard
    // (app/routes/app/intelligence/index.tsx). GRR is computed but drawn
    // nowhere, so it is not ticked.
    "Monthly NRR trend and per-plan MRR breakdown on the Intelligence dashboard",
    "Churn risk page with MRR by health band",
    // Recova's "Customer timeline: recovery, dispute, and Intelligence events
    // in one view" is left out: the customer page has no timeline (customer.tsx).
    // Truthfulness: Recova reads "included in weekly digest".
    "Monthly AI narrative report on the dashboard",
    // Recova's "Intelligence signals feed into Recovery timing and Disputes
    // triage" is left out (APPROVED-DIFFERENCES, the Intelligence entry).
  ],
};

export const INTELLIGENCE_FAQS = [
  {
    q: "How is the health score calculated?",
    // Truthfulness: Recova's three bands and "MRR percentile" are not the
    // score; risk.ts's signals and baseline are. Each factor that moved the
    // score is listed on the customer page with its points.
    a: `${signalCount} signals move the 0-100 score up or down from a baseline of ${HEALTH_SCORE_BASELINE}: ${signalsExplained}. Each signal that moved the score is shown separately, with its points, on the customer detail page.`,
  },
  {
    q: "Does Intelligence affect my Recovery sequences?",
    // Truthfulness: Recova reads "Yes. A continue_automated_deprioritize
    // recommendation delays email steps 48 hours ... A winback_priority
    // recommendation sends the first win-back email at 1 hour instead of 4
    // hours. Intelligence signals also feed into [the disputes product's]
    // triage scoring."
    // Foxhound has no deprioritize delay and computes no dispute triage
    // (APPROVED-DIFFERENCES, the Intelligence entry): failed-payment
    // RECOVERY_SCHEDULES are keyed on decline category alone. It DOES keep
    // legacy's win-back gate (process.ts resolveWinbackStep1Offset), which
    // delays win-back step 1 for every customer not flagged winback_priority,
    // so the answer says so (winback-copy.ts).
    a: `Not for failed payments. Retries and recovery emails follow the decline category alone, one schedule for each of the ${countWord(DECLINE_CATEGORY_COUNT).toLowerCase()} decline categories, the same for every customer, and Intelligence scores no dispute. One timing does change. ${INTELLIGENCE_WINBACK_SENTENCE}`,
  },
  {
    q: "What is the difference between Intelligence and the free Audit?",
    // Truthfulness: Recova's "surfaces actionable recommendations"; see above.
    a: "The Audit is a one-time diagnostic snapshot of your Stripe account. Intelligence is a continuous nightly scoring system that tracks customer health over time, surfaces the customers most at risk, and tracks MRR trends. The Audit is a starting point. Intelligence is an ongoing operational layer.",
  },
];

export const INTELLIGENCE_BOTTOM_CTA = {
  title: "Your highest-value customers are telling you they are at risk.",
  sub: "Intelligence surfaces them before they churn.",
  note: "The free audit shows your current MRR and involuntary churn rate",
};
