import { AUDIT_SUMMARY_STRUCTURE } from "~/lib/audit/summary";
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

// The /product/audit copy (J55). Recova's spec is
// app/(marketing)/product/audit/page.tsx (blob 210ce79d) and
// components/docs/AuditScopeCard.tsx (blob dc1d18dd), read whole, and this is
// their copy word for word, with three kinds of change only:
//
// - Branding: Recova becomes Foxhound (RULES.md 1.2).
// - Every product fact is read from Foxhound's engine, never typed (RULES.md
//   2.1): the lookback from AUDIT_LOOKBACK_DAYS, the scope and the anonymous
//   window from audit-access.ts (STRIPE_AUDIT_SCOPE, AUDIT_TOKEN_TTL_SECONDS),
//   the auto-run day from CRON_SCHEDULE_MONTHLY_AUDIT, and the summary's sentences
//   from the prompt's own plan (AUDIT_SUMMARY_STRUCTURE).
// - Truthfulness fixes where Recova's words describe something the audit does
//   not do (RULES.md 1.2). Each is named beside its string below. The ones that
//   recur:
//   * The recovery estimate is an assumption. Recova's results show a
//     "Recoverable estimate" at a fixed 30% baseline and its FAQ cites a
//     32.26% platform rate. Foxhound's results show the 30% estimate, named as
//     an assumption (AUDIT_RECOVERY_ESTIMATE_PCT, Dustin 2026-10-29), and no
//     platform rate, which RULES.md 2.3 forbids.
//   * No dispute deadlines. The audit's dispute read keeps status, amount,
//     currency and submission count (narrowDispute in app/lib/stripe/reads.ts).
//   * The expiring-card window is this month and next, already-expired cards
//     included (computeExpiringCards in app/lib/audit/engine.ts), not 30 days.
//   * No work on past failures. A sequence starts only from an
//     invoice.payment_failed that arrives after the account connects; an
//     invoice already uncollectible is ignored (app/lib/webhooks/process.ts,
//     no_failed_payment). So the summary example says what Foxhound does as
//     payments fail, not that it works the invoices the audit found.
//   * An anonymous run is not saved. Its results live on a five-minute cookie
//     (AUDIT_TOKEN_COOKIE) and no row is written (app/routes/audit/results.tsx).
//     Recova said 30 days at the URL; its own run was the same cookie. The
//     page says "session": the five minutes are the cookie's, and Foxhound
//     revokes the OAuth grant when they end unless a Foxhound account holds
//     that Stripe account (app/lib/audit/grant-revoke.server.ts).
//   * No "Read-only". Recova said "Read-only" while requesting read_write. 362
//     ruling 1 made the scope read_only to match; on 2026-10-29 Stripe refused
//     read_only in production (only Extensions may use it), so the scope is
//     read_write again and the copy says what is true: Stripe asks for read and
//     write access, Foxhound only reads, and Foxhound disconnects itself after
//     the window (audit-access.ts).
//
// Every one of these is listed in the J55 PR notes for the seat to read.

/** The day of the month the monthly audit fires, as "1st". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}
/** The cron's day-of-month field. */
const AUDIT_AUTO_RUN_DAY = Number(CRON_SCHEDULE_MONTHLY_AUDIT.trim().split(/\s+/)[2]);
const autoRunDay = ordinal(AUDIT_AUTO_RUN_DAY);

const summarySentences = countWord(AUDIT_SUMMARY_STRUCTURE.length).toLowerCase();
/** "the biggest revenue leak with its dollar amount, what Foxhound fixes
 *  automatically today, and one forward-looking risk or opportunity". */
const summaryPlan = (() => {
  const parts = AUDIT_SUMMARY_STRUCTURE.map((s) => {
    const bare = s.replace(/\.$/, "");
    return bare.charAt(0).toLowerCase() + bare.slice(1);
  });
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
})();

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
    // Truthfulness: Recova reads "Four scopes pull 90 days of data". Only the
    // uncollectible-invoice read is bounded by the lookback
    // (readUncollectibleInvoices); open invoices, subscriptions and disputes
    // are read whole (app/lib/stripe/reads.ts), the dispute win rate is all
    // time, and expiring cards and business health are the account today.
    body: `Four scopes read your account, going back ${AUDIT_LOOKBACK_DAYS} days for failed invoices: failed invoices, expiring cards, open disputes, and business health. AI generates a plain-English summary.`,
  },
  {
    title: "See your results",
    body: "Results are immediate. Save them to your account for persistent history and monthly auto-run.",
  },
];

export const AUDIT_SECTION_LABEL = "What you get";

/** Recova's AuditScopeCard: a glyph, a title and one line per scope. */
export const AUDIT_SCOPES = [
  // Truthfulness: Recova reads "and estimated recovery value". See above.
  { icon: "↯", title: "Failed invoices", desc: "Unrecovered failed payments and their total value" },
  // Truthfulness: Recova reads "Cards expiring within 30 days". See above.
  { icon: "⊘", title: "Expiring cards", desc: "Cards expired or expiring by the end of next month, and MRR at risk" },
  // Truthfulness: Recova reads "Active disputes, deadlines, and historical win
  // rate". The read carries no deadline; it carries the amount.
  { icon: "⚖", title: "Open disputes", desc: "Active disputes, the amount at stake, and historical win rate" },
  { icon: "◎", title: "Business health", desc: "MRR, ARR, active subscriptions, and churn rate" },
];

export const AUDIT_BLOCKS = {
  scopes: {
    eyebrow: "What it checks",
    title: "Four scopes. One diagnostic.",
    // Truthfulness: Recova's failed-invoice clause continues "and estimates
    // what intelligent sequences would return", and its disputes show
    // "deadlines". See above.
    body: "Failed invoices show what is unrecovered. Expiring cards show MRR at risk before the failure happens. Open disputes show the amount at stake and historical win rates. Business health shows MRR, ARR, and voluntary vs involuntary churn rate.",
  },
  summary: {
    eyebrow: "Plain English",
    title: "A summary that tells you what matters.",
    // Truthfulness: Recova reads "an AI-generated 2-3 sentence interpretation
    // of the most significant finding. If your account is clean, it says so
    // directly. If there is a problem, it names it specifically and tells you
    // what to do about it." The prompt asks for three sentences in a fixed
    // plan and says nothing about a clean account, and a static note stands in
    // when the model cannot answer (AUDIT_SUMMARY_FALLBACK). Recova's prompt
    // is the same one.
    body: `At the top of every audit result, an AI-generated ${summarySentences}-sentence interpretation: ${summaryPlan}. If the summary cannot be generated, a general note stands in its place.`,
  },
  history: {
    eyebrow: "Track over time",
    title: "Results that do not disappear.",
    // Truthfulness: Recova reads "Without an account, results are accessible
    // at the URL for 30 days." and "every audit run saves permanently". An
    // anonymous run is not saved, and a signed-in run is saved only when the
    // audited Stripe account is connected to the account (RULES.md 4.14).
    body: `Without an account, results are not saved: they show while the ${AUDIT_GRANT_MINUTES}-minute session lasts. With a Foxhound account, every audit of your connected Stripe account saves permanently at /audit/dashboard. Enable monthly auto-run and Foxhound re-runs the diagnostic on the ${autoRunDay} of each month and emails you results.`,
  },
};

export const AUDIT_PRICING = {
  price: "Free",
  priceLabel: "Always. No strings.",
  points: [
    "Four diagnostic scopes: failed invoices, expiring cards, disputes, business health",
    "AI-generated plain-English summary",
    // Truthfulness: Recova reads "results accessible via URL for 30 days".
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
    // Truthfulness: Recova's answer is a 30% baseline and a 32.26% platform
    // rate. Foxhound keeps the baseline, read from the constant the results
    // page uses, and has no platform rate (RULES.md 2.3).
    a: `It is an assumption, not a measurement. The estimate is ${AUDIT_RECOVERY_ESTIMATE_PCT}% of your unrecovered failed invoices. Foxhound does not yet have a recovery rate of its own to base it on, so your real result may be higher or lower. The other figures in the audit are what your account actually shows.`,
  },
];

export const AUDIT_BOTTOM_CTA = {
  title: "Your Stripe account is telling you something.",
  sub: "The audit shows you what. Free, reads only, 30 seconds.",
  note: "No account required · Reads only · Results in 30 seconds",
};

/** The Plain English preview: an example summary in the prompt's plan, with
 *  Recova's example account. Each figure is a separate part so it can be set
 *  in mono, as Recova's are. Truthfulness: Recova's third sentence applies a
 *  "30% recovery baseline"; Foxhound's summary plan has no estimate, so the
 *  example's second sentence is what Foxhound fixes, and its third the risk. */
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

/** The Track over time preview: Recova's three example runs, dated on the
 *  day the monthly audit fires. */
export const AUDIT_HISTORY_EXAMPLE = [
  { month: 4, summary: "6 failed · 3 expiring · 0 disputes" },
  { month: 3, summary: "4 failed · 1 expiring · 1 dispute" },
  { month: 2, summary: "2 failed · 0 expiring · 0 disputes" },
].map((run) => ({
  date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, run.month, AUDIT_AUTO_RUN_DAY)),
  ),
  summary: run.summary,
}));
