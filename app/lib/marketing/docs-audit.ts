import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  AUDIT_LOOKBACK_DAYS,
  CAU_EVENT_RETENTION_DAYS,
  MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY,
} from "~/lib/constants";
import {
  AUDIT_ACCESS_ASK,
  AUDIT_ACCESS_PROMISE,
  AUDIT_GRANT_MINUTES,
} from "~/lib/marketing/audit-access";
import type { DocGuide } from "~/lib/marketing/docs-content";

export const AUDIT_GUIDE: Omit<DocGuide, "datePublished"> = {
  slug: "audit",
  title: "Audit",
  description:
    "Free Stripe diagnostic. What Stripe already recovered, what is still dying, and what Foxhound would add.",
  heading: "Audit",
  sections: [
    {
      heading: "How the Audit works",
      body: [
        {
          kind: "p",
          body: [
            "The audit at ",
            { link: "/audit", to: "/audit" },
            ` connects to your Stripe account with OAuth and reads the last ${AUDIT_LOOKBACK_DAYS} days, or the lookback you set under Settings and Audit when you are signed in. It reads four scopes and puts a short written summary at the top.`,
          ],
        },
        "Foxhound runs the full audit on demand: connect Stripe from the audit page and the run happens while you wait. The audit only reads. It writes nothing back to Stripe.",
        "No Foxhound account is required. Share the audit link with colleagues: they can run it against their own Stripe account without signing up.",
        { kind: "widget", name: "audit-scopes" },
        {
          kind: "note",
          body: `The audit uses a connection of its own, separate from the one a Foxhound account uses. ${AUDIT_ACCESS_ASK} ${AUDIT_ACCESS_PROMISE} Your billing configuration, your subscriptions and your payment methods are never touched.`,
        },
      ],
    },
    {
      heading: "The four scopes",
      body: [
        { kind: "h3", text: "Failed invoices" },
        "Every failed invoice in the lookback window that is still unpaid: how many, their total value, and how the total splits across Foxhound's six decline categories.",
        "The audit does not project a recovery rate from platform-wide statistics. Foxhound applies no flat recovery estimate to at-risk value, because there is no Foxhound history to draw such a rate from.",
        { kind: "h3", text: "Expiring cards" },
        "Active subscriptions whose card has expired or expires this month or next, counted once per customer, with the MRR those subscriptions carry if their payments fail.",
        {
          kind: "p",
          body: [
            { strong: "Card Account Updater signal." },
            ` If Stripe updated none of your cards in the last ${CAU_EVENT_RETENTION_DAYS} days while ${MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY} or more expired-card declines hit your account in the same window, the audit says so as an advisory, with the common causes. Stripe's updater prevents many expired-card failures before they happen.`,
          ],
        },
        { kind: "h3", text: "Open disputes" },
        "Every open dispute: how many and the amount at stake. Beside them, the disputes you lost without submitting any evidence, and your won and lost record.",
        { kind: "h3", text: "Business health" },
        "Your MRR, ARR, active subscription count, and churn rate, split into voluntary (the customer canceled) and involuntary (a payment failed). The involuntary rate is the one Foxhound works on.",
      ],
    },
    {
      heading: "Reading your results",
      body: [
        "The summary at the top is a few plain sentences on what stands out. When the AI model is not available, a fixed sentence takes its place.",
        "Below it, the results come in three sections: Revenue leaking now (failed invoices by category, the Card Updater line, expiring cards, past-due subscriptions, and a recoverable estimate that assumes 30% of the failed invoices come back), Disputes unmanaged, and Business snapshot. Where a scope could not be read, it says so rather than showing you a zero, because a zero that means unknown is worse than no number at all.",
      ],
    },
    {
      heading: "Saving results",
      body: [
        {
          kind: "p",
          body: [
            "Sign in to Foxhound before you run the audit and the run is saved to ",
            { link: "Audit history", to: "/audit/dashboard" },
            ", each run on its own page, so you can follow your numbers over time. It is saved only when the Stripe account you audited is the one connected to the Foxhound account you are in: audit somebody else's account and you still see the results, and they are not filed into your history.",
          ],
        },
        `Without an account nothing is stored. The results page reads your Stripe account for as long as the ${AUDIT_GRANT_MINUTES}-minute audit session lasts. Then Foxhound disconnects itself, unless you have connected a Foxhound account, and you run the audit again to see new numbers.`,
      ],
    },
    {
      heading: "Auto-run",
      body: [
        "With a Foxhound account, turn on the monthly audit digest under Settings and Audit, and on the 1st of each month Foxhound runs the whole audit again and emails you the result at your notification address, with a link to that run and a line saying what Foxhound recovered for you. It is ONE email. It uses the lookback you set on the same page, and nothing is billed for it.",
        {
          kind: "note",
          body: "The report reads your Stripe account fresh, so it needs a live Stripe connection rather than only Foxhound's own records. A scope Stripe would not answer for says so in the email, as it does on the page. Turn auto-run off and nothing is sent.",
        },
      ],
    },
    {
      heading: "Using the audit to evaluate Foxhound",
      body: [
        `The failed invoices scope is the most direct read of what Foxhound would work on: it is the money that failed and is still unpaid. Foxhound's fee is ${RECOVERY_FEE_PERCENT}% of a recovery it can show it caused, and nothing on what Stripe recovers by itself, so there is no cost where there is no recovery.`,
        "If the failed invoices scope reads zero, Foxhound Recovery has nothing to add right now, and the audit will not tell you otherwise.",
      ],
    },
  ],
};
