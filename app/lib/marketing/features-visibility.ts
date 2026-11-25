import { recoveryRateTone } from "~/lib/dashboard/recovery-rate";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection, FeatureFacts } from "~/lib/marketing/features-content";

function recoveryRateBands(): { redMax: number; cautionMax: number } {
  let redMax = -1;
  let cautionMax = -1;
  for (let pct = 0; pct <= 100; pct++) {
    const tone = recoveryRateTone(pct);
    if (tone === "red") redMax = pct;
    if (tone === "caution") cautionMax = pct;
  }
  return { redMax, cautionMax };
}

export function visibilitySection(
  { nightly }: FeatureCadence,
  facts: FeatureFacts,
): FeatureSection {
  const { redMax, cautionMax } = recoveryRateBands();
  const ranges = RECOVERY_RANGES.join(" / ");

  return {
    id: "visibility",
    label: "Visibility",
    title: "Visibility",
    intro:
      "Everything you can see: across your payments, sequences, customers, disputes, and platform health.",
    features: [
      {
        name: "Recovery dashboard",
        description: `Stat cards, ROI widget, charts, and the recovery queue. Range: ${ranges}.`,
        product: "Recovery",
      },
      {
        name: "Recovery rate chart",
        description: `Daily recovery rate over the chosen range, beside the rate itself colored by band: green above ${cautionMax}%, caution ${redMax + 1}-${cautionMax}%, red at or below ${redMax}%.`,
        product: "Recovery",
      },
      {
        name: "Recovery timing chart",
        description: "Bar chart of when recoveries happen, by days since the payment failed.",
        product: "Recovery",
      },
      {
        name: "Email category chart",
        description:
          "Open rate and click rate per decline category. Shows which category your customers respond to most.",
        product: "Recovery",
      },
      {
        name: "Decline breakdown",
        description: "Category distribution with per-category recovery rate and sparklines.",
        product: "Recovery",
      },
      {
        name: "Payment detail timeline",
        description:
          "Every step in a payment's sequence: scheduled, sent, pending. Exact timestamps, results, and email preview.",
        product: "Recovery",
      },
      {
        name: "Email preview in timeline",
        description: "The rendered email body is visible on every sent email step.",
        product: "Recovery",
      },
      {
        name: "Sequence performance page",
        description: "Open, click, and recovery rate per sequence step, across all sequences.",
        product: "Recovery",
      },
      {
        name: "Disputes dashboard",
        description:
          "Disputes needing action, the amount at stake, historical win rate, and fees owed.",
        product: "Disputes",
      },
      {
        name: "Dispute evidence staging",
        description:
          "The full evidence draft before submission, grounded in the charge's recovery history and the emails the customer received.",
        product: "Disputes",
      },
      {
        name: "Intelligence dashboard",
        description: `MRR, NRR trend, MRR movement chart, health score distribution, and the ${nightly} narrative.`,
        product: "Intelligence",
      },
      {
        name: "Customer health index",
        description:
          "All customers sorted by health score ascending, or by MRR. Worst-health customers surface first.",
        product: "Intelligence",
      },
      {
        name: "Customer detail page",
        description:
          "Health score with its factors, score history sparkline, predictions, and MRR contribution.",
        product: "Intelligence",
      },
      {
        name: "Churn risk page",
        description:
          "MRR at risk by health band, the churn rate trend chart, and the high-risk customer table sorted by MRR.",
        product: "Intelligence",
      },
      {
        name: "MRR movement waterfall",
        description: "New, expansion, reactivation vs contraction, churn. Month by month.",
        product: "Intelligence",
      },
      {
        name: "Audit results page",
        description:
          "Failed invoices, expiring cards, open disputes, and business health. AI summary at top.",
        product: "Audit",
      },
      {
        name: "Audit history",
        description: "Signed-in accounts see every past audit run at /audit/dashboard.",
        product: "Audit",
      },
      {
        name: "Platform status in Help",
        description: "Live cron health (last run and status) visible at /help.",
        product: "Platform",
      },
      {
        name: "Admin webhook log",
        description:
          "Recent webhook deliveries with their status and errors, and 24-hour received and error counts.",
        product: "Platform",
      },
      {
        name: "Admin audit log",
        description: "Recent admin actions with actor, action, and metadata.",
        product: "Platform",
      },
      {
        name: "Cron health table",
        description: `All ${facts.cronJobCount} crons with last-run status in /admin/platform/crons.`,
        product: "Platform",
      },
    ],
  };
}
