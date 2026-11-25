import { appOrigin } from "~/lib/app-origin";
import {
  compareTotals,
  buildMonthlyAuditEmail,
  MONTHLY_AUDIT_FROM_NAME,
} from "~/lib/audit/monthly-email";
import {
  autoSubmittedNotice,
  createdNotice,
  DISPUTE_NOTICE_FROM_NAME,
  disputeNoticeFooterNote,
  nextDisputeBillingRun,
  outcomeNotice,
  reminderNotice,
} from "~/lib/disputes/notices";
import type { EmailNotice } from "~/lib/email/templates";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recoveryFooterNote } from "~/lib/email/templates";
import {
  criticalCustomersContent,
  thresholdAlertContent,
} from "~/lib/intelligence/alert-notify.server";
import { digestContent } from "~/lib/recovery/digest-email";
import { buildExpiringCardEmail } from "~/lib/recovery/expiring-card-email";
import { recoveryNotifyContent } from "~/lib/recovery/merchant-notification.server";
import { sequenceCompleteContent } from "~/lib/recovery/sequence-complete-notification.server";
import { buildTeamInviteJob } from "~/lib/settings/team-invite-email.server";

import { DISPUTE_TYPES, type PreparedEmail, type PrepareInput } from "./email-catalog";
import {
  SAMPLE_AMOUNT_CENTS,
  SAMPLE_CURRENCY,
  SAMPLE_CUSTOMER_LABEL,
  sampleAuditResult,
} from "./email-samples";

/** The merchant mail types; null when the type is not one of them. */
export async function prepareMerchantEmail(
  env: Env,
  input: PrepareInput,
): Promise<PreparedEmail | null> {
  const { type, to, merchant, now } = input;
  const baseUrl = appOrigin(env);
  const senderName = merchant?.senderName ?? null;
  const merchantJob = (
    content: { subject: string; fromName: string; footerNote?: string } & (
      | { bodyHtml: string }
      | { notice: EmailNotice }
      | { blocks: ReturnType<typeof buildExpiringCardEmail> }
    ),
  ): PreparedEmail => ({
    channel: "job",
    audience: "merchant",
    job: {
      accountId: merchant?.accountId ?? null,
      to,
      ...content,
      template: `admin_test:${type.type}`,
      unsubscribeToken: "",
      physicalAddress: "",
      idempotencyKey: `admin-test:${crypto.randomUUID()}`,
      cronRunId: null,
      audience: "merchant",
    },
  });
  const sample = {
    amountCents: SAMPLE_AMOUNT_CENTS,
    currency: SAMPLE_CURRENCY,
    customerLabel: SAMPLE_CUSTOMER_LABEL,
  };
  const paymentUrl = `${baseUrl}/recovery/payments`;
  if (type.type === "weekly_digest") {
    if (!merchant) throw new Error("the weekly digest needs a merchant");
    const flags = { now, disputesActive: true };
    return {
      channel: "job",
      audience: "digest",
      job: {
        accountId: merchant.accountId,
        to,
        ...digestContent({
          ...flags,
          personalOutreachCount: 2,
          totalFailed: 12,
          totalRecovered: 7,
          recoveredRevenue: [{ currency: SAMPLE_CURRENCY, cents: 69300 }],
          atRiskRevenue: [{ currency: SAMPLE_CURRENCY, cents: 118800 }],
          activeCount: 5,
          emailsSent: 31,
          winBackCount: 2,
          expiringCardCount: 3,
          openDisputeCount: 1,
          openDisputeAmounts: [{ currency: SAMPLE_CURRENCY, cents: 4900 }],
          currency: SAMPLE_CURRENCY,
          senderName,
          highRiskCustomers: [],
          baseUrl,
        }),
        template: `admin_test:${type.type}`,
        unsubscribeToken: await signUnsubscribeToken(env, {
          email: to,
          accountId: merchant.accountId,
          list: "digest",
        }),
        physicalAddress: env.PHYSICAL_ADDRESS ?? "",
        idempotencyKey: `admin-test:${crypto.randomUUID()}`,
        cronRunId: null,
        audience: "digest",
      },
    };
  }
  if (type.type === "recovery_notification") {
    // The notifier's own content function: the notice and its footer.
    return merchantJob(
      recoveryNotifyContent({ ...sample, declineCategory: "soft" }, paymentUrl, now),
    );
  }
  if (type.type === "sequence_complete") {
    // The notifier's own content function: the notice and its footer.
    return merchantJob(sequenceCompleteContent(sample, paymentUrl, now));
  }
  if (type.type === "alert_threshold") {
    // The alert's own content function.
    const firing = {
      alertId: "alert_sample",
      accountId: merchant?.accountId ?? "",
      metric: "mrr_at_risk_cents",
      thresholdValue: 100000,
      direction: "above",
      actualValue: 125000,
      channel: "email",
    };
    return merchantJob(thresholdAlertContent(firing, baseUrl, now));
  }
  if (type.type === "alert_critical_customers") {
    // The alert's own content function.
    return merchantJob(criticalCustomersContent(2, baseUrl, now));
  }
  if ((DISPUTE_TYPES as readonly string[]).includes(type.type)) {
    // The notices' own content functions on a sample dispute. Every button
    // goes to the disputes list: the sample has no row.
    const listUrl = `${baseUrl}/disputes/dashboard`;
    const dispute = {
      amountCents: 4900,
      currency: SAMPLE_CURRENCY,
      customerLabel: SAMPLE_CUSTOMER_LABEL,
      reason: "product_not_received",
      disputeUrl: listUrl,
    };
    const notice =
      type.type === "dispute_created"
        ? createdNotice({
            ...dispute,
            evidenceDeadline: new Date(now.getTime() + 10 * 86_400_000),
            triage: {
              recommendation: "fight",
              confidence: 78,
              reasoning: "Delivery was confirmed by the carrier.",
            },
            autoSubmit: false,
          })
        : type.type === "dispute_reminder"
          ? reminderNotice({ ...dispute, daysLeft: 3, approved: false, autoSubmit: false })
          : type.type === "dispute_auto_submitted"
            ? autoSubmittedNotice(dispute)
            : outcomeNotice({
                ...dispute,
                won: type.type === "dispute_won",
                foxhoundSubmitted: true,
                feeCents: type.type === "dispute_won" ? 980 : null,
                feeCurrency: SAMPLE_CURRENCY,
                invoiceDate: nextDisputeBillingRun(now),
                listUrl,
              });
    return merchantJob({
      fromName: DISPUTE_NOTICE_FROM_NAME,
      ...notice,
      footerNote: disputeNoticeFooterNote(senderName, now.getUTCFullYear()),
    });
  }
  if (type.type === "monthly_audit") {
    // The report's own builder on a sample audit, with a first month and a
    // prior one to compare against.
    const email = buildMonthlyAuditEmail({
      result: sampleAuditResult(now),
      summary: "A sample month: recoveries are up, and three cards expire soon.",
      runId: "sample",
      baseUrl,
      comparisons: compareTotals(
        [{ currency: SAMPLE_CURRENCY, cents: 69300 }],
        [{ currency: SAMPLE_CURRENCY, cents: 41500 }],
      ),
    });
    return merchantJob({
      fromName: MONTHLY_AUDIT_FROM_NAME,
      ...email,
      footerNote: recoveryFooterNote(MONTHLY_AUDIT_FROM_NAME, now.getUTCFullYear()),
    });
  }
  if (type.type === "team_invite") {
    // The invite's own job builder, with no token in the link.
    const invite = buildTeamInviteJob({
      accountId: merchant?.accountId ?? "",
      to,
      accountName: merchant?.name ?? null,
      inviteUrl: `${baseUrl}/settings/team`,
      memberId: "sample",
      token: "",
      senderName,
      year: now.getUTCFullYear(),
    });
    return merchantJob({
      fromName: invite.fromName ?? "Foxhound",
      subject: invite.subject,
      bodyHtml: invite.bodyHtml,
      footerNote: invite.footerNote ?? undefined,
    });
  }
  return null;
}
