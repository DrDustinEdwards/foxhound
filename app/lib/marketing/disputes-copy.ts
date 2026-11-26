import { DISPUTE_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { DEADLINE_SOON_DAYS, DEADLINE_URGENT_DAYS } from "~/lib/disputes/labels";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

// The /product/disputes copy. Every product fact is read from the engine, never typed: the fee from DISPUTE_FEE_PERCENT, the
// cap from DISPUTE_FEE_CAP_CENTS, the deadline bands from DEADLINE_SOON_DAYS and DEADLINE_URGENT_DAYS. Where a sentence would
// claim more than Foxhound does, the reason is beside the string. Recurring: every submission stands on a person's approval,
// enforced by the schema (Approve and submit, or auto-submit, which is off by default; app/lib/cron/dispute-auto-submit.ts);
// triage and the Stripe context are read at intake (app/lib/disputes/triage.ts, context.server.ts); the fee is capped.

const pct = `${DISPUTE_FEE_PERCENT}%`;
const cap = formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd");

// Submission waits for an approval, and the fee is capped.
export const DISPUTES_META_DESCRIPTION = `Automated dispute evidence building and Stripe submission once you approve. ${pct} only when you win, capped at ${cap}.`;

export const DISPUTES_HERO = {
  headline: `Evidence built automatically.\n${pct} only when you win.`,
  // Foxhound submits only what a person approved.
  sub: "When a dispute opens, Foxhound builds evidence from your recovery history, Stripe signals, and transaction data, then submits it to Stripe once someone on your team approves it. You pay nothing on disputes you lose or accept.",
  pricing: `${pct} of won disputes, capped at ${cap} · Nothing on losses or accepted disputes · Invoiced monthly`,
};

export const DISPUTES_STEPS = [
  {
    title: "Dispute opens on Stripe",
    body: "Foxhound receives the webhook within seconds and begins building evidence from prior charges, recovery emails, AVS/CVV results, Radar signals, and 3DS authentication data.",
  },
  {
    // Foxhound stages a draft for every dispute.
    title: "Foxhound scores the dispute",
    body: "A 0-100 triage score with a fight or accept recommendation. Every dispute has its evidence pre-staged.",
  },
  {
    title: "Submit or accept",
    // "approve it and" names the approval gate.
    body: `Review staged evidence, approve it and submit. Or accept if the score is low. Auto-submit fires 24 hours before the deadline if enabled. ${pct} only when the submission wins.`,
  },
];

export const DISPUTES_SECTION_LABEL = "What you see after connecting";

export const DISPUTES_BLOCKS = {
  dashboard: {
    title: "Every dispute. Status. Deadline. Fee.",
    // A deadline inside the soon band is amber, as the dashboard draws it (deadlineClassName, the caution token). The Mode column
    // is not drawn on the dashboard or this preview.
    body: `The disputes dashboard shows every open and closed dispute with customer, amount, reason, Foxhound's status, and deadline proximity. Deadlines inside ${DEADLINE_SOON_DAYS} days appear in amber. Inside ${DEADLINE_URGENT_DAYS} days, red.`,
  },
  numbers: {
    // Foxhound computes no saving (app/lib/disputes/stats.ts says why), its fees owed are not a month's, and Stripe's 30% is a
    // statistic with no source named.
    title: "Open disputes. At stake. Fees owed.",
    body: "The dashboard surfaces what matters immediately: open disputes, total amount at stake, how many Foxhound has submitted, and fees owed. How much you saved compared to Stripe's Smart Disputes is not built yet.",
  },
  evidence: {
    // The Stripe Radar link is plain text here, as the block body is a string.
    title: "Built automatically before you open it.",
    body: "Prior charge history, recovery email history, AVS and CVV results, Stripe Radar score, and 3D Secure authentication. All staged before you see the dispute. The triage table shows fight/accept recommendation and confidence for every dispute.",
  },
};

export const DISPUTES_PRICING = {
  price: pct,
  priceLabel: `of disputes Foxhound wins, capped at ${cap} per dispute`,
  points: [
    "Nothing on disputes you lose or accept",
    "Evidence built automatically from 5 sources",
    "0-100 triage score with fight/accept recommendation",
    // app/lib/cron/dispute-auto-submit.ts: off until turned on.
    "Auto-submit 24 hours before the deadline (toggle on)",
    // app/lib/cron/dispute-reminders.ts sends both.
    "Deadline reminder emails at 3 days and 1 day",
    // Won and lost counts go on the customer's Intelligence profile (buildDisputeSignals); the score counts disputes, not outcomes (risk.ts).
    "Outcome feeds back into the customer's Intelligence profile",
    "Invoiced monthly alongside Recovery fee",
  ],
};

export const DISPUTES_FAQS = [
  {
    question: "Does Foxhound handle all dispute types?",
    // Foxhound takes in every reason Stripe sends and drafts the subscription record and the recovery email log.
    answer:
      "Foxhound drafts evidence for every dispute reason Stripe sends, fraudulent, subscription_canceled and unrecognized among them. Fraudulent disputes have the highest win rate when authentication signals exist. Subscription_canceled disputes depend on the subscription record and email history.",
  },
  {
    question: "What if I want to submit evidence myself?",
    answer:
      "You can edit any pre-staged evidence before submitting. Add context in the uncategorized text field, attach files, or rewrite the structured evidence. Foxhound's evidence is a starting point, not a constraint.",
  },
  {
    question: "What does Foxhound charge if a dispute is accepted?",
    answer: `Nothing. Foxhound's ${pct} fee only applies to disputes that Foxhound wins. Accepted disputes and lost disputes have no Foxhound fee.`,
  },
];

export const DISPUTES_BOTTOM_CTA = {
  title: "Stop losing disputes to missed deadlines.",
  sub: `Connect Stripe and Foxhound starts building evidence on every new dispute automatically. Read and write Stripe access, and ${pct} only when you win.`,
};
