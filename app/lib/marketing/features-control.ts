import { AUDIT_LOOKBACK_DAYS, ALERT_METRICS } from "~/lib/constants";
import { LOOKBACK_OPTIONS } from "~/lib/settings/audit-settings";
import { listText } from "capsomer/behavior/hooks";
import type { FeatureCadence } from "~/lib/marketing/features-cadence";
import type { FeatureSection } from "~/lib/marketing/features-content";

export function controlSection({ auditWhen, auditCadence }: FeatureCadence): FeatureSection {
  const lookbacks = listText(LOOKBACK_OPTIONS.map(String), "or");

  return {
    id: "control",
    label: "Control",
    title: "Control",
    intro:
      "What you can configure, override, or stop. Foxhound runs automatically. You have explicit control over everything it does.",
    features: [
      {
        name: "Stop recovery",
        description:
          "Stop a payment's recovery permanently from the payment detail page. No further steps will run, and the subscription is never touched.",
        product: "Recovery",
      },
      {
        name: "Run the next step now",
        description:
          "Run the next scheduled step for any payment in an active sequence, without waiting for its time.",
        product: "Recovery",
      },
      {
        name: "Resend email step",
        description:
          "Resend the last email sent for a payment. The suppression list is checked first.",
        product: "Recovery",
      },
      {
        name: "Manual payment recovery",
        description:
          "Mark a payment recovered by hand from the payment detail page. Manual recoveries are never billed.",
        product: "Recovery",
      },
      {
        name: "Payment notes",
        description: "Add an internal note to any payment.",
        product: "Recovery",
      },
      {
        name: "Submit dispute evidence",
        description:
          "Review the drafted evidence, edit any field, attach files, and approve its submission to Stripe. The fee is stated on the button.",
        product: "Disputes",
      },
      {
        name: "Accept dispute",
        description:
          "Close a dispute without submitting evidence. No Foxhound fee on accepted disputes.",
        product: "Disputes",
      },
      {
        name: "Audit lookback days",
        description: `Choose the lookback window (${lookbacks} days, default ${AUDIT_LOOKBACK_DAYS}) for your Stripe diagnostic.`,
        product: "Audit",
      },
      {
        name: "Audit auto-run toggle",
        description: `Enable the ${auditCadence} audit in Settings. It runs on ${auditWhen} and emails you the results.`,
        product: "Audit",
      },
      {
        name: "Processing pause",
        description: "A per-account pause that stops recovery and dispute processing immediately.",
        product: "Platform",
      },
      {
        name: "Alert thresholds",
        description: `Configure metric alerts (${ALERT_METRICS.length} metrics) with custom thresholds, directions, and channels (email or Slack).`,
        product: "Platform",
      },
      {
        name: "Email settings",
        // The notification email is the account's, on the notifications page, not the connection's.
        description:
          "Sender name and reply-to address per Stripe connection, and a test email to your own address.",
        product: "Platform",
      },
      {
        name: "Brand voice",
        description: "Per-decline-category tone configuration. Influences AI email generation.",
        product: "Recovery",
      },
      {
        name: "Merchant context",
        // Those two are kept in Dispute settings for evidence and triage; the recovery email context is industry, customer type and MRR.
        description:
          "Industry, customer type, and MRR, used in recovery email copy. Product description and ships-physical-goods flag, used in dispute evidence.",
        product: "Recovery",
      },
      {
        name: "Theme toggle",
        description:
          "Dark/light mode toggle. Saved to your account when signed in, a cookie otherwise.",
        product: "Platform",
      },
      {
        name: "Team seats",
        description: "Invite teammates by email from Settings, Team.",
        product: "Platform",
      },
    ],
  };
}
