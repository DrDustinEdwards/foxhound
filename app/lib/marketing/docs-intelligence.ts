import {
  CRITICAL_HEALTH_SCORE_MAX,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_REPORT_HOURLY_LIMIT,
} from "~/lib/constants";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import type { DocGuide } from "~/lib/marketing/docs-content";

export const INTELLIGENCE_GUIDE: Omit<DocGuide, "datePublished"> = {
  slug: "intelligence",
  title: "Intelligence",
  description: "Customer health scores, churn risk and MRR trends, free on every account.",
  heading: "Intelligence",
  sections: [
    {
      heading: "How Intelligence works",
      body: [
        "Each night Intelligence scores the customers it has synced from your Stripe account. Every customer gets a health score from 0 to 100, and the score puts them in one of three bands.",
        { kind: "widget", name: "health-bands" },
        "The score is a way of sorting. What it is for is finding the customers worth your attention before they leave.",
        {
          kind: "note",
          body: "Intelligence is free and on for every account. There is nothing to subscribe to or turn on.",
        },
      ],
    },
    {
      heading: "Health scores",
      body: [
        { kind: "h3", text: "The 0-100 score" },
        "Every customer starts from the same baseline, and five signals move the score from there:",
        {
          kind: "list",
          items: [
            [
              { strong: "Payment timing." },
              " Paying later and later against the due date pulls the score down; paying early lifts it a little.",
            ],
            [
              { strong: "Billing changes." },
              " Plan, billing interval and seat changes count as volatility and pull it down.",
            ],
            [{ strong: "Refunds and disputes." }, " Each one on record pulls it down."],
            [
              { strong: "Recovery engagement." },
              " A customer who has had failed payments and never engaged with a recovery email, or not for half a year, loses points.",
            ],
            [{ strong: "Tenure." }, " Long-standing customers gain points."],
          ],
        },
        "A customer with none of these on record keeps the baseline score rather than being penalized or left unscored.",
        { kind: "widget", name: "customer-columns" },
        { kind: "h3", text: "Score thresholds and colors" },
        {
          kind: "p",
          body: [
            { badge: 20 },
            ` Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}, at risk. `,
            { badge: 50 },
            ` ${HEALTH_SCORE_AT_RISK_THRESHOLD} to ${WATCH_CEILING - 1}, watch. `,
            { badge: 82 },
            ` ${WATCH_CEILING} and above, healthy.`,
          ],
        },
        {
          kind: "note",
          body: `The bands are strict at the edges: anything below ${HEALTH_SCORE_AT_RISK_THRESHOLD} is at risk, so a ${HEALTH_SCORE_AT_RISK_THRESHOLD - 1} reads as at risk and ${HEALTH_SCORE_AT_RISK_THRESHOLD} as watch. Each badge and band above is drawn from the same constant the engine scores with, so they cannot drift.`,
        },
      ],
    },
    {
      heading: "Recommendations",
      body: [
        { kind: "h3", text: "Four action types" },
        "Intelligence produces one of four recommendations per customer:",
        {
          kind: "list",
          items: [
            [
              { strong: "Personal outreach." },
              " High value customer showing disengagement or failure history, or a customer who used to recover well and has stopped opening emails. Reach out directly.",
            ],
            [
              { strong: "Continue automated." },
              " The automated flow is doing its job, no action needed from you.",
            ],
            [
              { strong: "Continue automated (priority)." },
              " High value, not enough history to call it yet, flag for monitoring.",
            ],
            [
              { strong: "Continue automated (deprioritize)." },
              " Not a high value customer, with weak engagement or recovery history. The automated sequence continues on its usual timing.",
            ],
          ],
        },
        "Customers needing action appear on the Recommendations page grouped by action type: personal outreach under Reach out personally, priority under Watch closely, highest MRR first. Customers on continue automated or continue automated (deprioritize) are excluded: they need nothing from you.",
      ],
    },
    {
      heading: "Churn risk",
      body: [
        "The churn page splits your MRR across the three health bands, with how many customers are in each, so the question it answers is how much money is sitting in at-risk customers rather than how many of them there are.",
        "Below that, the high-risk customers are listed with the highest monthly contribution first, so the most valuable customer at risk is the first one you read.",
      ],
    },
    {
      heading: "MRR trends",
      body: [
        "The Intelligence dashboard charts total MRR and MRR by plan, net revenue retention over the last 90 days, where above 100% means expansion outran churn, and the MRR movement behind it by week: new, expansion, reactivation, contraction and churn.",
        "A week whose total barely moves can still be hiding a lot of both, which is what the movement chart is for. Customer data is synced from Stripe every day, and once right after you connect, so each bar is a week of those days.",
      ],
    },
    {
      heading: "Monthly narrative",
      body: [
        "Each night, after scoring, Foxhound writes a short narrative for the account: total MRR, how it moved, the MRR at risk, and a line on each of the at-risk customers that matter most. It is written from a template using only the scores and signals Foxhound computed, so it never states anything they do not.",
        "The current month's narrative is on the Intelligence dashboard and is rewritten each night, and every month keeps its own under Reports.",
        `You can also generate this month's report from the dashboard yourself, up to ${INTELLIGENCE_REPORT_HOURLY_LIMIT} times an hour.`,
      ],
    },
    {
      heading: "Settings",
      body: [
        { kind: "h3", text: "Health alert" },
        `The Alerts section of Settings and Notifications lets you set a threshold on the number of high-risk customers, those with a health score of ${CRITICAL_HEALTH_SCORE_MAX} or below, or on the MRR they carry, firing when the metric drops below or rises above your number. Foxhound checks after each recovery run, records each breach under Recent triggers on that page, and sends it by email or to Slack, no more than once a day for each alert. It does not alert on one customer's score.`,
      ],
    },
  ],
};
