import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import { formatMoneyShort } from "~/lib/money-format";

// The /product/disputes copy (J57). Recova's spec is
// app/(marketing)/product/disputes/page.tsx (blob c412d54f), read whole, and
// this is its copy word for word, with three kinds of change only:
//
// - Branding: Recova becomes Foxhound (RULES.md 1.2).
// - Every product fact is read from Foxhound's engine, never typed (RULES.md
//   2.1): the fee from DISPUTE_FEE_BPS, the cap from DISPUTE_FEE_CAP_CENTS,
//   the deadline bands from the dashboard's own DEADLINE_SOON_DAYS and
//   DEADLINE_URGENT_DAYS.
// - Truthfulness fixes where Recova's words describe something Foxhound does
//   not do (RULES.md 1.2). Each is named beside its string below. The ones
//   that recur:
//   * No auto-submit. Every submission waits for a person's approval, enforced
//     by the schema (RULES.md 5.6, 3.6; app/lib/disputes/submission.ts).
//   * No triage. triage_recommendation has no producer outside the demo seed
//     (app/components/docs/doc-widgets.tsx records the same finding).
//   * Evidence comes from the recovery behind the disputed charge only: the
//     plan, the service date and the recovery emails, plus a summary written
//     from those facts (app/lib/disputes/evidence.ts). Prior charges, AVS and
//     CVV, Radar and 3D Secure have no producer outside the demo seed.
//   * The fee is capped (PRICING.md; DISPUTE_FEE_CAP_CENTS).
//
// Every one of these is listed in the J57 PR notes for the seat to read.

const pct = `${DISPUTE_FEE_BPS / 100}%`;
const cap = formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd");

// Truthfulness: Recova reads "Automated dispute evidence building and Stripe
// submission." Submission waits for an approval, and the fee is capped.
export const DISPUTES_META_DESCRIPTION = `Automated dispute evidence building and Stripe submission once you approve. ${pct} only when you win, capped at ${cap}.`;

export const DISPUTES_HERO = {
  headline: `Evidence built automatically.\n${pct} only when you win.`,
  // Truthfulness: Recova builds from "your recovery history, Stripe signals,
  // and transaction data" and "then submits it to Stripe before the
  // deadline". Foxhound's evidence is the plan, service date and recovery
  // emails of the recovery behind the charge (evidence.ts), all of it recovery
  // history, and it submits only what a person approved.
  sub: "When a dispute opens, Foxhound builds evidence from your recovery history, then submits it to Stripe once someone on your team approves it. You pay nothing on disputes you lose or accept.",
  // Truthfulness: the cap.
  pricing: `${pct} of won disputes, capped at ${cap} · Nothing on losses or accepted disputes · Invoiced monthly`,
};

export const DISPUTES_STEPS = [
  {
    title: "Dispute opens on Stripe",
    // Truthfulness: see the evidence note above.
    body: "Foxhound receives the webhook within seconds and begins building evidence from the recovery behind the disputed charge: the plan, the service date and the recovery emails.",
  },
  {
    // Truthfulness: Recova reads "Recova scores the dispute" and "A 0-100
    // triage score with a fight or accept recommendation. High-confidence
    // fight recommendations have evidence pre-staged." Foxhound computes no
    // triage, so the step says what Foxhound does and that triage is not built.
    title: "Foxhound stages the evidence",
    body: "The evidence is staged as a draft before you open the dispute. A triage score with a fight or accept recommendation is not built yet.",
  },
  {
    title: "Submit or accept",
    // Truthfulness: Recova reads "Review staged evidence and submit. Or accept
    // if the score is low. Auto-submit fires 24 hours before the deadline if
    // enabled." There is no score and no auto-submit, and accepting is done in
    // Stripe: Foxhound's dispute page has no accept action.
    body: `Review staged evidence, approve it and submit. Or accept the dispute in Stripe. Nothing reaches Stripe until someone on your team approves it. ${pct} only when the submission wins.`,
  },
];

export const DISPUTES_SECTION_LABEL = "What you see after connecting";

export const DISPUTES_BLOCKS = {
  dashboard: {
    eyebrow: "What you see after connecting",
    title: "Every dispute. Status. Deadline. Fee.",
    // Recova names its own accent colour here. Foxhound is teal throughout
    // (Q11) and draws a deadline inside the soon band in its
    // warning color, as the dashboard does (deadlineClassName).
    // Truthfulness: Recova's "whether it is an active fee relationship" is its
    // Mode column, which the dashboard and this preview do not draw (Mode is
    // out for good, Dustin, 2026-10-15,
    // cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6).
    body: `The disputes dashboard shows every open and closed dispute with customer, amount, reason, Foxhound's status, and deadline proximity. Deadlines inside ${DEADLINE_SOON_DAYS} days appear in the warning color. Inside ${DEADLINE_URGENT_DAYS} days, red.`,
  },
  numbers: {
    eyebrow: "The numbers",
    // Truthfulness: Recova reads "Open disputes. At stake. Saved vs Stripe."
    // and "fees owed this month, and how much you saved compared to Stripe's
    // Smart Disputes (which charges 30% vs Recova's 20%)". Foxhound computes
    // no saving (app/lib/disputes/stats.ts says why Recova's formula is not
    // ported), its fees owed are not a month's, and Stripe's 30% is a
    // statistic with no source named (RULES.md 2.3).
    title: "Open disputes. At stake. Fees owed.",
    body: "The dashboard surfaces what matters immediately: open disputes, total amount at stake, how many Foxhound has submitted, and fees owed. How much you saved compared to Stripe's Smart Disputes is not built yet.",
  },
  evidence: {
    // Truthfulness: Recova reads "Five evidence sources" and lists prior
    // charges, recovery emails, AVS and CVV, the Stripe Radar score (linked)
    // and 3D Secure, then "The triage table shows fight/accept recommendation
    // and confidence for every dispute." Foxhound has one source, the recovery
    // behind the charge, and no triage.
    eyebrow: "Built from your recovery history",
    title: "Built automatically before you open it.",
    body: "From the recovery behind the disputed charge: the plan, the service date, every recovery email the customer was sent, opened or clicked, and a short summary written only from those facts. All staged before you see the dispute. Prior charge history, AVS and CVV results, the Stripe Radar score, 3D Secure authentication and a fight or accept triage recommendation are not built yet.",
  },
};

export const DISPUTES_PRICING = {
  price: pct,
  // Truthfulness: the cap.
  priceLabel: `of disputes Foxhound wins, capped at ${cap} per dispute`,
  points: [
    "Nothing on disputes you lose or accept",
    // Truthfulness: "from 5 sources"; see the evidence note above.
    "Evidence built automatically from your recovery history",
    // Recova's "0-100 triage score with fight/accept recommendation" is left
    // out: Foxhound computes no triage, and a ticked line would claim it.
    // Truthfulness: Recova's "Auto-submit 24 hours before the deadline (toggle
    // on)". Auto-submit is deliberately not built (RULES.md 5.6), and copy
    // describes it as absent (RULES.md 3.6).
    "No auto-submit: nothing reaches Stripe until you approve it",
    // Recova's "Deadline reminder emails at 3 days and 1 day" is left out:
    // Foxhound sends no dispute deadline email (app/lib/cron, app/lib/email).
    // Truthfulness: Recova reads "Outcome feeds back into Intelligence customer
    // scoring". Foxhound records won and lost counts on the customer's
    // Intelligence profile (buildDisputeSignals); its score counts disputes,
    // not outcomes (app/lib/intelligence/risk.ts).
    "Outcome feeds back into the customer's Intelligence profile",
    "Invoiced monthly alongside Recovery fee",
  ],
};

export const DISPUTES_FAQS = [
  {
    q: "Does Foxhound handle all dispute types?",
    // Truthfulness: Recova reads "Recova handles fraudulent,
    // subscription_canceled, and unrecognized dispute reasons. Fraudulent
    // disputes have the highest win rate when authentication signals exist."
    // Foxhound takes in every reason Stripe sends, gathers no authentication
    // signals, and states no win rate without a source (RULES.md 2.3). Recova's
    // "cancellation evidence and email history": Foxhound drafts no
    // cancellation evidence, only the recovery email log (evidence.ts).
    a: "Foxhound drafts evidence for every dispute reason Stripe sends, fraudulent, subscription_canceled and unrecognized among them. The draft is built from the recovery behind the disputed charge, so a dispute on a charge Foxhound recovered has the most to work with. Subscription_canceled disputes depend on the recovery email history.",
  },
  {
    q: "What if I want to submit evidence myself?",
    // Truthfulness: Recova reads "Add context in the uncategorized text field,
    // attach files, or rewrite the structured evidence." Foxhound edits the
    // fields it drafted; attaching files is not built (RULES.md 3.22, file
    // evidence storage).
    a: "You can edit any pre-staged evidence before submitting. Rewrite the structured evidence or the summary in the uncategorized text field. Attaching files is not built yet. Foxhound's evidence is a starting point, not a constraint.",
  },
  {
    q: "What does Foxhound charge if a dispute is accepted?",
    a: `Nothing. Foxhound's ${pct} fee only applies to disputes that Foxhound wins. Accepted disputes and lost disputes have no Foxhound fee.`,
  },
];

export const DISPUTES_BOTTOM_CTA = {
  title: "Stop losing disputes to missed deadlines.",
  sub: "Connect Stripe and Foxhound starts building evidence on every new dispute automatically.",
  // Truthfulness: Recova reads "Read-only Stripe access" under a /connect
  // button. /connect asks for read and write (RULES.md 2.2).
  note: `Read and write Stripe access · ${pct} only when you win`,
};
