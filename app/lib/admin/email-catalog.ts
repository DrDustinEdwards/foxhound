import type { EmailAudience, OutboundEmailJob } from "~/lib/email/types";
import type { Rendered } from "capsomer/email";

import type { MerchantEmailSettings } from "./email-targets.server";

export type AdminEmailAudience = "customer" | "merchant" | "platform";

export interface AdminEmailType {
  type: string;
  audience: AdminEmailAudience;
  description: string;
}

/**
 * Where every button in a test mail points instead of a tracked or card-update
 * link: the page the merchant's own "Send test email" button already uses.
 */
export const ADMIN_EMAIL_STAND_IN_PATH = "/settings/email";

export const ADMIN_EMAIL_AUDIT_ACTION = "email.test_send";

export const RECOVERY_STEPS: Record<
  string,
  { stepType: string; declineCategory: string; label: string }
> = {
  recovery_day1: { stepType: "email_day1", declineCategory: "soft", label: "first" },
  recovery_day3: { stepType: "email_day3", declineCategory: "soft", label: "day 3" },
  recovery_day7: { stepType: "email_day7", declineCategory: "soft", label: "day 7" },
  recovery_day14: { stepType: "email_day14", declineCategory: "soft", label: "day 14" },
  recovery_day30: { stepType: "email_day30", declineCategory: "soft", label: "final (day 30)" },
  recovery_revoked: {
    stepType: "email_revoked",
    declineCategory: "revoked",
    label: "revoked authorization",
  },
};

/** The five dispute notices, by type. */
export const DISPUTE_TYPES = [
  "dispute_created",
  "dispute_reminder",
  "dispute_auto_submitted",
  "dispute_won",
  "dispute_lost",
] as const;

export const ADMIN_EMAIL_TYPES: readonly AdminEmailType[] = [
  ...Object.entries(RECOVERY_STEPS).map(([type, step]) => ({
    type,
    audience: "customer" as const,
    description: `The ${step.label} failed-payment recovery email a merchant's customer gets, from the merchant's sender name with its Reply-To.`,
  })),
  ...[1, 2, 3].map((n) => ({
    type: `winback_step${n}`,
    audience: "customer" as const,
    description: `Win-back email ${n} of 3, sent to a customer who canceled, from the merchant's sender name with its Reply-To.`,
  })),
  {
    type: "expiring_card",
    audience: "customer",
    description: "The expiring-card warning a merchant's customer gets before their card expires.",
  },
  {
    type: "expiring_card_no_payment_method",
    audience: "customer",
    description:
      "The expiring-card alert's variant for a trialing customer with no payment method set up, sent before the trial converts.",
  },
  {
    type: "recovery_resend",
    audience: "customer",
    description:
      "The recovery email a merchant resends by hand from a payment's page: the step's stored copy (here the first email's template) with the resend's own footer line.",
  },
  {
    type: "settings_test",
    audience: "customer",
    description:
      "What the merchant's own Send test email button sends: a sample recovery email marked PREVIEW, with the merchant's sender name and Reply-To and no unsubscribe.",
  },
  {
    type: "weekly_digest",
    audience: "merchant",
    description:
      "The weekly recovery summary a merchant gets at their notification address, with sample numbers and a working unsubscribe. Needs account_id.",
  },
  {
    type: "recovery_notification",
    audience: "merchant",
    description: "The Payment recovered notice a merchant gets when a payment is recovered.",
  },
  {
    type: "sequence_complete",
    audience: "merchant",
    description: "The notice a merchant gets when a recovery sequence ends without a payment.",
  },
  {
    type: "alert_threshold",
    audience: "merchant",
    description:
      "The Intelligence threshold alert (E21) a merchant gets when a metric crosses the threshold they set; sample: MRR at risk above $1,000.",
  },
  {
    type: "alert_critical_customers",
    audience: "merchant",
    description:
      "The critical customers alert (E22): customers with an active recovery, a low health score and an open dispute at once.",
  },
  {
    type: "dispute_created",
    audience: "merchant",
    description:
      "The notice a merchant gets when a new dispute arrives, with its evidence deadline and triage recommendation.",
  },
  {
    type: "dispute_reminder",
    audience: "merchant",
    description:
      "The deadline reminder a merchant gets 3 days (and again 1 day) before a dispute's evidence is due.",
  },
  {
    type: "dispute_auto_submitted",
    audience: "merchant",
    description:
      "The notice a merchant with auto-submit on gets when Foxhound submits a dispute's response 24 hours before its deadline.",
  },
  {
    type: "dispute_won",
    audience: "merchant",
    description:
      "The notice a merchant gets when a dispute Foxhound submitted is won, with the fee and when it is invoiced.",
  },
  {
    type: "dispute_lost",
    audience: "merchant",
    description: "The notice a merchant gets when a dispute is closed as lost.",
  },
  {
    type: "monthly_audit",
    audience: "merchant",
    description:
      "The monthly Foxhound report (E24) a merchant with audit auto-run on gets, on a sample audit. Its View full audit button goes to a sample run id, which no account holds.",
  },
  {
    type: "team_invite",
    audience: "merchant",
    description:
      "The team invite a teammate gets. Its Accept Invite button goes to /settings/team with no token, so it joins nobody to anything.",
  },
  {
    type: "sign_in_link",
    audience: "platform",
    description:
      "The email with a sign-in link. Its button goes to the sign-in page with no token, so it signs nobody in.",
  },
  {
    type: "cron_failure",
    audience: "platform",
    description: "The operations alert (E26) the support inbox gets when a cron fails.",
  },
  {
    type: "cron_stale",
    audience: "platform",
    description:
      "The operations alert (E27) the support inbox gets when a cron has not succeeded within its expected interval.",
  },
  {
    type: "email_failed_alert",
    audience: "platform",
    description:
      "The operations alert the support inbox gets when a recovery email fails after every retry.",
  },
];

const TYPE_IDS = ADMIN_EMAIL_TYPES.map((t) => t.type);

export function findAdminEmailType(type: unknown): AdminEmailType | null {
  return ADMIN_EMAIL_TYPES.find((t) => t.type === type) ?? null;
}

export function unknownTypeMessage(type: unknown): string {
  return `${typeof type === "string" && type ? `There is no email type "${type.slice(0, 60)}".` : "Send type."} The types are: ${TYPE_IDS.join(", ")}.`;
}

/** One email ready for the send module, in the shape its sender takes. */
export type PreparedEmail =
  | { channel: "job"; audience: EmailAudience; job: OutboundEmailJob }
  | { channel: "rendered"; to: string; rendered: Rendered }
  | { channel: "transactional"; to: string; subject: string; bodyHtml: string };

export interface PrepareInput {
  type: AdminEmailType;
  to: string;
  merchant: MerchantEmailSettings | null;
  now: Date;
}
