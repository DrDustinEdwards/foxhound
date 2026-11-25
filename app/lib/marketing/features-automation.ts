import { EXPIRING_CARD_DAYS_AHEAD, RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { capitalize } from "@drdustinedwards/site-helpers/text";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection } from "~/lib/marketing/features-content";

export function automationSection({
  tick,
  billingWhen,
  auditWhen,
  digestDay,
  nightly,
  Nightly,
  CardsCadence,
  daily,
  Monthly,
  auditCadence,
}: FeatureCadence): FeatureSection {
  const fee = `${RECOVERY_FEE_PERCENT}%`;

  return {
    id: "automation",
    label: "Automation",
    title: "Automation",
    intro:
      "Everything that runs without you doing anything. Foxhound processes failed payments, sends emails, retries charges, drafts dispute evidence, and alerts you. All on schedule, all automatically.",
    features: [
      {
        name: `Recovery processing every ${tick} minutes`,
        description: `Picks due recovery steps and executes them every ${tick} minutes.`,
        product: "Recovery",
      },
      {
        // Foxhound's dispute-reminders job rides the tick and runs auto-submit for accounts that turned it on; there is no clean-up job.
        name: `Dispute processing every ${tick} minutes`,
        description: `Checks dispute deadlines, fires reminders, and auto-submits evidence when you have turned it on, every ${tick} minutes.`,
        product: "Disputes",
      },
      {
        name: `Win-back processing every ${tick} minutes`,
        description: `Executes win-back email steps on schedule, checked every ${tick} minutes.`,
        product: "Recovery",
      },
      {
        name: `${CardsCadence} expiring card alerts`,
        description: `${CardsCadence}, finds every card expiring within ${EXPIRING_CARD_DAYS_AHEAD} days and emails the customer a link to Foxhound's card-update page.`,
        product: "Recovery",
      },
      {
        name: `${Nightly} intelligence scoring`,
        description: `Computes health scores and predictions for every customer ${nightly}.`,
        product: "Intelligence",
      },
      {
        name: `${capitalize(daily)} MRR snapshots`,
        description: `Pulls subscription data from Stripe and computes MRR, NRR, GRR, and the movement waterfall. Updated ${nightly}, and once right after Stripe connects.`,
        product: "Intelligence",
      },
      {
        name: `${Monthly} recovery billing`,
        description: `Invoices ${fee} of matured Foxhound-attributed recoveries (held ${RECOVERY_MATURITY_DAYS} days or more) on ${billingWhen}. Recoveries Stripe would have made anyway are never billed.`,
        product: "Platform",
      },
      {
        name: `${capitalize(auditCadence)} audit auto-run`,
        description: `Re-runs your Stripe diagnostic on ${auditWhen} and emails you the results. Toggle on in Settings.`,
        product: "Audit",
      },
      {
        name: `${digestDay} unified digest`,
        description:
          "Weekly email covering recovery stats, open disputes, and Intelligence high-risk customers.",
        product: "Platform",
      },
      {
        name: `${Nightly} demo reset`,
        description: `Rebuilds the demo accounts' data ${nightly}. The demo never touches live Stripe.`,
        product: "Platform",
      },
      {
        name: "Cron overlap prevention",
        description: "A Durable Object lock per cron. Overlapping runs are blocked, not queued.",
        product: "Platform",
      },
      {
        name: "Stale cron alerting",
        description: `A ${daily} check finds any cron that has not run within its expected window, or has never run, and sends an operator alert.`,
        product: "Platform",
      },
    ],
  };
}
