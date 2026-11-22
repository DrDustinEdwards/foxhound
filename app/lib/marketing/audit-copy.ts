import { formatDate } from "capsomer/behavior/time";
import { AUDIT_SUMMARY_STRUCTURE } from "~/lib/audit/summary";
import { ordinal } from "~/lib/billing/page";
import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_RECOVERY_ESTIMATE_PCT,
  CRON_SCHEDULE_MONTHLY_AUDIT,
} from "~/lib/constants";
import {
  AUDIT_ACCESS_ASK,
  AUDIT_ACCESS_PROMISE,
  AUDIT_GRANT_MINUTES,
  AUDIT_SCOPE_WORDS,
} from "~/lib/marketing/audit-access";
import { countWord } from "~/lib/marketing/decline-categories";
import { listText } from "capsomer/behavior/hooks";

// The /product/audit copy. Every product fact is read from Foxhound's engine, never typed: the lookback from
// AUDIT_LOOKBACK_DAYS, the scope and anonymous window from audit-access.ts, the auto-run day from CRON_SCHEDULE_MONTHLY_AUDIT,
// the summary's sentences from AUDIT_SUMMARY_STRUCTURE. Where a sentence would claim more than the audit does, the reason is
// beside the string. The recurring ones: the 30% recovery estimate is an assumption (AUDIT_RECOVERY_ESTIMATE_PCT) and no
// platform rate is shown; no dispute deadlines (narrowDispute keeps status, amount, currency, submissions); the expiring-card
// window is this month and next, expired included; no work on past failures (a sequence starts only from a later
// invoice.payment_failed); an anonymous run is not saved (a five-minute cookie, AUDIT_TOKEN_COOKIE, and the OAuth grant is
// revoked when it ends unless a Foxhound account holds that Stripe account); the scope is read_write because Stripe refuses
// read_only in production, so the copy says Stripe asks for read and write, Foxhound only reads and disconnects itself.

const AUDIT_AUTO_RUN_DAY = Number(CRON_SCHEDULE_MONTHLY_AUDIT.trim().split(/\s+/)[2]);
const autoRunDay = ordinal(AUDIT_AUTO_RUN_DAY);

const summarySentences = countWord(AUDIT_SUMMARY_STRUCTURE.length).toLowerCase();
const summaryPlan = listText(
  AUDIT_SUMMARY_STRUCTURE.map((s) => {
    const bare = s.replace(/\.$/, "");
    return bare.charAt(0).toLowerCase() + bare.slice(1);
  }),
);

export const AUDIT_META_DESCRIPTION =
  "Free Stripe diagnostic. See failed invoices, expiring cards, open disputes, and business health in 30 seconds. No account required.";

export const AUDIT_HERO = {
  headline: "See what your Stripe account is leaking. Free.",
  sub: `A full diagnostic across failed invoices, expiring cards, open disputes, and business health. AI summary. No signup, no credit card. Foxhound only reads, and disconnects itself after ${AUDIT_GRANT_MINUTES} minutes.`,
  pricing: `Always free · No account required · Disconnects after ${AUDIT_GRANT_MINUTES} minutes`,
};

export const AUDIT_STEPS = [
  {
    title: "Connect Stripe",
    body: `Stripe OAuth connection. Stripe asks for ${AUDIT_SCOPE_WORDS} access, because it no longer offers read-only to platforms. Foxhound only reads and never touches your billing configuration. It disconnects itself after ${AUDIT_GRANT_MINUTES} minutes. Takes 30 seconds.`,
  },
  {
    title: "Foxhound runs the diagnostic",
    // Only the uncollectible-invoice read is bounded by the lookback; open invoices, subscriptions and disputes are read whole
    // (app/lib/stripe/reads.ts), the dispute win rate is all time, expiring cards and business health are the account today.
    body: `Four scopes read your account, going back ${AUDIT_LOOKBACK_DAYS} days for failed invoices: failed invoices, expiring cards, open disputes, and business health. AI generates a plain-English summary.`,
  },
  {
    title: "See your results",
    body: "Results are immediate. Save them to your account for persistent history and monthly auto-run.",
  },
];

export const AUDIT_SECTION_LABEL = "What you get";

/** A glyph, a title and one line per scope. */
export const AUDIT_SCOPES = [
  {
    icon: "↯",
    title: "Failed invoices",
    desc: "Unrecovered failed payments and their total value",
  },
  {
    icon: "⊘",
    title: "Expiring cards",
    desc: "Cards expired or expiring by the end of next month, and MRR at risk",
  },
  // The dispute read carries no deadline; it carries the amount.
  {
    icon: "⚖",
    title: "Open disputes",
    desc: "Active disputes, the amount at stake, and historical win rate",
  },
  { icon: "◎", title: "Business health", desc: "MRR, ARR, active subscriptions, and churn rate" },
];

export const AUDIT_BLOCKS = {
  scopes: {
    title: "Four scopes. One diagnostic.",
    body: "Failed invoices show what is unrecovered. Expiring cards show MRR at risk before the failure happens. Open disputes show the amount at stake and historical win rates. Business health shows MRR, ARR, and voluntary vs involuntary churn rate.",
  },
  summary: {
    title: "A summary that tells you what matters.",
    // The prompt asks for three sentences in a fixed plan and says nothing about a clean account; a static note stands in when
    // the model cannot answer (AUDIT_SUMMARY_FALLBACK).
    body: `At the top of every audit result, an AI-generated ${summarySentences}-sentence interpretation: ${summaryPlan}. If the summary cannot be generated, a general note stands in its place.`,
  },
  history: {
    title: "Results that do not disappear.",
    // An anonymous run is not saved; a signed-in run is saved only when the audited Stripe account is connected to the account.
    body: `Without an account, results are not saved: they show while the ${AUDIT_GRANT_MINUTES}-minute session lasts. With a Foxhound account, every audit of your connected Stripe account saves permanently at /audit/dashboard. Enable monthly auto-run and Foxhound re-runs the diagnostic on the ${autoRunDay} of each month and emails you results.`,
  },
};

export const AUDIT_PRICING = {
  price: "Free",
  priceLabel: "Always. No strings.",
  points: [
    "Four diagnostic scopes: failed invoices, expiring cards, disputes, business health",
    "AI-generated plain-English summary",
    "No account required, results are not saved without one",
    "Persistent history with a Foxhound account",
    "Monthly auto-run with email delivery (toggle on in Settings)",
    `Reads only and disconnects after ${AUDIT_GRANT_MINUTES} minutes, your billing configuration is never touched`,
  ],
};

export const AUDIT_FAQS = [
  {
    q: "Does the audit require a Foxhound account?",
    a: "No. Connect your Stripe account at /audit and results appear immediately. No email, no signup, no credit card. If you want to save results and enable monthly auto-run, you can create a free account afterward.",
  },
  {
    q: "What Stripe access does the audit request?",
    a: `${AUDIT_ACCESS_ASK} The audit reads your invoices, subscriptions, disputes, and customer data. It never modifies payment methods, subscription logic, or any other Stripe settings. ${AUDIT_ACCESS_PROMISE} You can also disconnect from your Stripe dashboard at any time.`,
  },
  {
    q: "How accurate is the recovery estimate?",
    // The baseline is read from the constant the results page uses; there is no platform rate.
    a: `It is an assumption, not a measurement. The estimate is ${AUDIT_RECOVERY_ESTIMATE_PCT}% of your unrecovered failed invoices. Foxhound does not yet have a recovery rate of its own to base it on, so your real result may be higher or lower. The other figures in the audit are what your account actually shows.`,
  },
];

export const AUDIT_BOTTOM_CTA = {
  title: "Your Stripe account is telling you something.",
  sub: "The audit shows you what. Free, reads only, 30 seconds.",
};

/** The Plain English preview: an example summary in the prompt's plan. Each figure is a separate part so it can be set in
 *  mono. The example's second sentence is what Foxhound fixes and its third the risk; the summary plan has no estimate. */
export const AUDIT_SUMMARY_EXAMPLE: Array<string | { figure: string }> = [
  "Your account has ",
  { figure: "$4,820" },
  " in unrecovered failed invoices across ",
  { figure: "6" },
  " invoices in the last ",
  { figure: String(AUDIT_LOOKBACK_DAYS) },
  " days. Foxhound recovers payments like these as they fail, with a sequence matched to the decline, and bills only on what it recovers. Three cards expire by the end of next month, representing ",
  { figure: "$297/mo" },
  " in MRR at risk.",
];

/** The Track over time preview: three example runs, dated on the day the monthly audit fires. */
export const AUDIT_HISTORY_EXAMPLE = [
  { month: 4, summary: "6 failed · 3 expiring · 0 disputes" },
  { month: 3, summary: "4 failed · 1 expiring · 1 dispute" },
  { month: 2, summary: "2 failed · 0 expiring · 0 disputes" },
].map((run) => ({
  date:
    formatDate(new Date(Date.UTC(2026, run.month, AUDIT_AUTO_RUN_DAY)), { style: "medium" }) ?? "",
  summary: run.summary,
}));
