import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db/schema";
import type { AuditResult } from "~/lib/audit/engine";
import { compareTotals, buildMonthlyAuditEmail, MONTHLY_AUDIT_FROM_NAME } from "~/lib/audit/monthly-email";
import { renderSignInLinkEmail } from "~/lib/auth/send-auth-email";
import { CRON_SCHEDULE_DAILY, DAY_MS } from "~/lib/constants";
import {
  buildFailureAlertEmail,
  buildStaleAlertEmail,
  deadLetterAlertMessage,
  renderCronAlertEmail,
} from "~/lib/cron/alerts.server";
import {
  autoSubmittedNotice,
  createdNotice,
  DISPUTE_NOTICE_FROM_NAME,
  disputeNoticeFooterNote,
  nextDisputeBillingRun,
  outcomeNotice,
  reminderNotice,
} from "~/lib/disputes/notices";
import {
  buildEmailMessage,
  buildRenderedTransactionalMessage,
  buildTransactionalMessage,
  sendEmail,
  sendRenderedTransactionalEmail,
  sendTransactionalEmail,
} from "~/lib/email/send";
import { isSuppressed } from "~/lib/email/suppression";
import type { EmailNotice } from "~/lib/email/templates";
import type { EmailAudience, OutboundEmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recoveryFooterNote } from "~/lib/engine/execute-step";
import { criticalCustomersContent, thresholdAlertContent } from "~/lib/intelligence/alert-notify.server";
import { digestContent } from "~/lib/recovery/digest-email";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import {
  buildExpiringCardEmail,
  buildNoPaymentMethodEmail,
  expiringCardSubject,
  noPaymentMethodSubject,
} from "~/lib/recovery/expiring-card-email";
import { resendFooterNote } from "~/lib/recovery/manual-action-deps.server";
import { recoveryNotifyContent } from "~/lib/recovery/merchant-notification.server";
import { sequenceCompleteContent } from "~/lib/recovery/sequence-complete-notification.server";
import { buildWinbackEmail, winbackSubject } from "~/lib/recovery/winback-email";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";
import { buildTeamInviteJob } from "~/lib/settings/team-invite-email.server";
import { buildTestEmailJob } from "~/lib/settings/test-email.server";

import type { Rendered } from "capsomer/email";

// SEND OR PREVIEW ANY EMAIL, for the owner only (admin API routes /emails,
// /emails/preview and /emails/send). Dustin approved it on 2026-10-15, message
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQLJoLik1xYvr9pCLcgZ3SSMJ, answering "ok" to:
// "build #1 and #2 together as one owner-only 'send or preview any email' tool
// behind your admin key". #1: after a deploy, send every email type to a test
// inbox to confirm delivery, links, unsubscribe and Reply-To. #2: render any
// email as a chosen merchant's customer would get it, without sending.
//
// WHO IT CAN MAIL. The acting admin's own address, or an address on the
// ADMIN_EMAIL_TEST_RECIPIENTS list, and nobody else (RULES.md 4.7: an address
// typed into a request would make Foxhound an open mail relay). Unset, the list
// is empty and only the caller's own inbox can receive.
//
// WHAT IT RENDERS. Each message is built by the same function the real sender
// uses, with the chosen merchant's sender name and Reply-To from its primary
// Stripe connection, and SAMPLE customer data: no customer row is ever read, so
// no customer's name or address can reach a preview or an inbox. The copy is the
// deterministic template, which is what a send uses whenever generation is not
// used or fails (RULES.md 3.15); brand voice only shapes model-written copy, and
// this module never calls the model, so the voice is returned beside the preview
// rather than applied to it.
//
// WHAT IT NEVER CREATES. No email_sends row (the real path's claim rows feed the
// weekly digest's counts and its once-a-week check, so a test row would skip a
// merchant's real digest), no engagement token, no tracked click, no open pixel,
// no scanner trap and no card-update token: every button points at the stand-in
// page below, so a click in a test mail records nothing anywhere and nothing a
// bill reads can come of it. The one signed link is the unsubscribe link, which
// works for real: following it suppresses the test inbox, as it would a
// customer's, which is what lets the unsubscribe path be checked end to end.
//
// HOW IT SENDS. Only through the one send module (app/lib/email/send.ts):
// sendEmail for customer and merchant mail, the transactional senders for
// platform mail. Customer and merchant mail honors suppression, as
// processEmailJob does, but skips the per-account live-send gate, because that
// gate exists to keep a merchant's customers from being mailed before the
// merchant is switched on, and this mail goes only to the caller's own inbox.
//
// EVERY EMAIL FOXHOUND SENDS IS HERE (parity gap 15): customer mail, every
// merchant notice (recovery, sequence end, the alerts E21 and E22, the four
// dispute notices, the monthly audit, the team invite), the sign-in link, and
// the operations mail to the support inbox (cron failure, cron stale, dead
// letters), which a test send delivers to the caller instead. A sender added
// without a type here is a gap.

type AdminEmailAudience = "customer" | "merchant" | "platform";

export interface AdminEmailType {
  type: string;
  audience: AdminEmailAudience;
  description: string;
}

/** Where every button in a test mail points instead of a tracked or card-update
 *  link: the page the merchant's own "Send test email" button already uses. */
export const ADMIN_EMAIL_STAND_IN_PATH = "/settings/email";

export const ADMIN_EMAIL_AUDIT_ACTION = "email.test_send";

const RECOVERY_STEPS: Record<string, { stepType: string; declineCategory: string; label: string }> = {
  recovery_day1: { stepType: "email_day1", declineCategory: "soft", label: "first" },
  recovery_day3: { stepType: "email_day3", declineCategory: "soft", label: "day 3" },
  recovery_day7: { stepType: "email_day7", declineCategory: "soft", label: "day 7" },
  recovery_day14: { stepType: "email_day14", declineCategory: "soft", label: "day 14" },
  recovery_day30: { stepType: "email_day30", declineCategory: "soft", label: "final (day 30)" },
  recovery_revoked: { stepType: "email_revoked", declineCategory: "revoked", label: "revoked authorization" },
};

/** The five dispute notices, by type (E16, E17, E19, E20, and the
 *  auto-submitted notice). */
const DISPUTE_TYPES = [
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
    description: "The expiring-card alert's variant for a trialing customer with no payment method set up, sent before the trial converts.",
  },
  {
    type: "recovery_resend",
    audience: "customer",
    description: "The recovery email a merchant resends by hand from a payment's page: the step's stored copy (here the first email's template) with the resend's own footer line.",
  },
  {
    type: "settings_test",
    audience: "customer",
    description: "What the merchant's own Send test email button sends: a sample recovery email marked PREVIEW, with the merchant's sender name and Reply-To and no unsubscribe.",
  },
  {
    type: "weekly_digest",
    audience: "merchant",
    description: "The weekly recovery summary a merchant gets at their notification address, with sample numbers and a working unsubscribe. Needs account_id.",
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
    description: "The Intelligence threshold alert (E21) a merchant gets when a metric crosses the threshold they set; sample: MRR at risk above $1,000.",
  },
  {
    type: "alert_critical_customers",
    audience: "merchant",
    description: "The critical customers alert (E22): customers with an active recovery, a low health score and an open dispute at once.",
  },
  {
    type: "dispute_created",
    audience: "merchant",
    description: "The notice a merchant gets when a new dispute arrives, with its evidence deadline and triage recommendation.",
  },
  {
    type: "dispute_reminder",
    audience: "merchant",
    description: "The deadline reminder a merchant gets 3 days (and again 1 day) before a dispute's evidence is due.",
  },
  {
    type: "dispute_auto_submitted",
    audience: "merchant",
    description: "The notice a merchant with auto-submit on gets when Foxhound submits a dispute's response 24 hours before its deadline.",
  },
  {
    type: "dispute_won",
    audience: "merchant",
    description: "The notice a merchant gets when a dispute Foxhound submitted is won, with the fee and when it is invoiced.",
  },
  {
    type: "dispute_lost",
    audience: "merchant",
    description: "The notice a merchant gets when a dispute is closed as lost.",
  },
  {
    type: "monthly_audit",
    audience: "merchant",
    description: "The monthly Foxhound report (E24) a merchant with audit auto-run on gets, on a sample audit. Its View full audit button goes to a sample run id, which no account holds.",
  },
  {
    type: "team_invite",
    audience: "merchant",
    description: "The team invite (E2) a teammate gets. Its Accept Invite button goes to /settings/team with no token, so it joins nobody to anything.",
  },
  {
    type: "sign_in_link",
    audience: "platform",
    description: "The email with a sign-in link. Its button goes to the sign-in page with no token, so it signs nobody in.",
  },
  {
    type: "cron_failure",
    audience: "platform",
    description: "The operations alert (E26) the support inbox gets when a cron fails.",
  },
  {
    type: "cron_stale",
    audience: "platform",
    description: "The operations alert (E27) the support inbox gets when a cron has not succeeded within its expected interval.",
  },
  {
    type: "dead_letter_alert",
    audience: "platform",
    description: "The operations alert the support inbox gets when dunning emails exhaust their queue retries and are dead-lettered.",
  },
];

const TYPE_IDS = ADMIN_EMAIL_TYPES.map((t) => t.type);

export function findAdminEmailType(type: unknown): AdminEmailType | null {
  return ADMIN_EMAIL_TYPES.find((t) => t.type === type) ?? null;
}

export function unknownTypeMessage(type: unknown): string {
  return `${typeof type === "string" && type ? `There is no email type "${type.slice(0, 60)}".` : "Send type."} The types are: ${TYPE_IDS.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

/** ADMIN_EMAIL_TEST_RECIPIENTS, lower-cased, separated by commas or spaces. */
export function testRecipientAllowList(env: Env): string[] {
  return (env.ADMIN_EMAIL_TEST_RECIPIENTS ?? "")
    .split(/[\s,]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

export type Recipient = { ok: true; to: string; kind: "self" | "allow_list" } | { ok: false; error: string };

/**
 * Who a test mail goes to. Omitted, the acting admin. Given, it must be one
 * address and either the acting admin's own or on the allow list; anything else
 * is refused, another admin's address included, because each admin chooses
 * their own inbox.
 */
export function resolveTestRecipient(env: Env, actorEmail: string, requested: unknown): Recipient {
  const actor = actorEmail.trim().toLowerCase();
  if (requested === undefined || requested === null) return { ok: true, to: actor, kind: "self" };
  const refusal = {
    ok: false as const,
    error:
      "Test mail goes only to your own address or to an address on ADMIN_EMAIL_TEST_RECIPIENTS. Omit to to send to yourself, or ask Dustin to add the inbox to that list.",
  };
  if (typeof requested !== "string") return refusal;
  const to = requested.trim().toLowerCase();
  if (!isValidReplyToEmail(to)) return refusal;
  if (to === actor) return { ok: true, to, kind: "self" };
  if (testRecipientAllowList(env).includes(to)) return { ok: true, to, kind: "allow_list" };
  return refusal;
}

// ---------------------------------------------------------------------------
// The merchant's settings
// ---------------------------------------------------------------------------

export interface MerchantEmailSettings {
  accountId: string;
  name: string | null;
  senderName: string | null;
  replyTo: string | null;
  brandVoice: { default: string | null; soft: string | null; expired: string | null; network: string | null; fraud: string | null };
}

/** The account and its primary live connection's sender settings, or null for
 *  an unknown account. Reads no customer data. */
export async function loadMerchantEmailSettings(db: Db, accountId: string): Promise<MerchantEmailSettings | null> {
  const [account] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) return null;
  const [connection] = await db
    .select({
      senderName: stripeConnections.senderName,
      replyTo: stripeConnections.replyToEmail,
      brandVoice: stripeConnections.brandVoice,
      soft: stripeConnections.brandVoiceSoft,
      expired: stripeConnections.brandVoiceExpired,
      network: stripeConnections.brandVoiceNetwork,
      fraud: stripeConnections.brandVoiceFraud,
    })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.accountId, accountId),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);
  return {
    accountId: account.id,
    name: account.name ?? null,
    senderName: connection?.senderName ?? null,
    replyTo: connection?.replyTo ?? null,
    brandVoice: {
      default: connection?.brandVoice ?? null,
      soft: connection?.soft ?? null,
      expired: connection?.expired ?? null,
      network: connection?.network ?? null,
      fraud: connection?.fraud ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Building one email
// ---------------------------------------------------------------------------

/** One email ready for the send module, in the shape its sender takes. */
export type PreparedEmail =
  | { channel: "job"; audience: EmailAudience; job: OutboundEmailJob }
  | { channel: "rendered"; to: string; rendered: Rendered }
  | { channel: "transactional"; to: string; subject: string; bodyHtml: string };

// Sample data, the same sample the merchant's Send test email uses where it has one.
const SAMPLE_AMOUNT_CENTS = 9900;
const SAMPLE_AMOUNT = "$99.00";
const SAMPLE_CURRENCY = "usd";
const SAMPLE_CUSTOMER_LABEL = "Sample Customer";

/** A sample audit for the monthly report: every scope read, in US dollars. */
function sampleAuditResult(now: Date): AuditResult {
  const usd = (cents: number) => [{ currency: SAMPLE_CURRENCY, cents }];
  const counted = (count: number, cents: number) => ({ count, totalCents: cents, totals: usd(cents) });
  return {
    failedInvoices: {
      ok: true,
      data: {
        ...counted(12, 118800),
        byCategory: { soft: 7, network: 1, expired: 3, fraud: 0, revoked: 0, unknown: 1 },
        byCategoryTotals: {
          soft: usd(69300),
          network: usd(9900),
          expired: usd(29700),
          fraud: [],
          revoked: [],
          unknown: usd(9900),
        },
      },
    },
    expiringCards: {
      ok: true,
      data: { count: 3, mrrAtRiskCents: 29700, mrrAtRiskTotals: usd(29700), expiresByMonth: {} },
    },
    pastDueSubscriptions: { ok: true, data: counted(2, 19800) },
    cardUpdater: {
      ok: true,
      data: { eventsInWindow: 4, expiredCardDeclinesInWindow: 1, advisory: null, windowDays: 30 },
    },
    disputes: {
      ok: true,
      data: { open: counted(1, 4900), acceptedWithoutFighting: counted(0, 0), historical: { won: 3, lost: 1 } },
    },
    health: {
      ok: true,
      data: {
        mrrCents: 1250000,
        arrCents: 15000000,
        mrrTotals: usd(1250000),
        arrTotals: usd(15000000),
        activeSubscriptionsCount: 126,
        voluntaryChurnRateBps: 210,
        involuntaryChurnRateBps: 90,
      },
    },
    meta: { stripeAccountId: "acct_sample", lookbackDays: 30, currency: SAMPLE_CURRENCY, ranAt: now },
  };
}

export interface PrepareInput {
  type: AdminEmailType;
  to: string;
  merchant: MerchantEmailSettings | null;
  now: Date;
}

/**
 * Build one email exactly as its real sender builds it, with sample customer
 * data and the stand-in link. Throws, as the real path would, when a needed
 * secret is missing (the unsubscribe signing key).
 */
export async function prepareAdminEmail(env: Env, input: PrepareInput): Promise<PreparedEmail> {
  const { type, to, merchant, now } = input;
  const baseUrl = env.BETTER_AUTH_URL ?? "";
  const standIn = `${baseUrl}${ADMIN_EMAIL_STAND_IN_PATH}`;
  const senderName = merchant?.senderName ?? null;

  if (type.audience === "customer") {
    if (!merchant) throw new Error("customer mail needs a merchant");
    const base = {
      accountId: merchant.accountId,
      to,
      fromName: senderName,
      replyTo: merchant.replyTo,
      unsubscribeToken: await signUnsubscribeToken(env, { email: to, accountId: merchant.accountId }),
      physicalAddress: env.PHYSICAL_ADDRESS ?? "",
      template: `admin_test:${type.type}`,
      idempotencyKey: `admin-test:${crypto.randomUUID()}`,
      cronRunId: null,
      audience: "customer" as const,
    };
    const job = (
      content: { subject: string; footerNote?: string } & (
        | { bodyHtml: string }
        | { blocks: ReturnType<typeof buildExpiringCardEmail> }
      ),
    ): PreparedEmail => ({
      channel: "job",
      audience: "customer",
      job: { ...base, ...content },
    });

    const step = RECOVERY_STEPS[type.type];
    if (step) {
      const copy = buildTemplateEmail({
        merchantName: senderName ?? "your subscription",
        declineCategory: step.declineCategory,
        amountFormatted: SAMPLE_AMOUNT,
        updateUrl: standIn,
        stepType: step.stepType,
        customerName: null,
        senderName,
      });
      return job({ ...copy, footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()) });
    }
    const winback = /^winback_step([123])$/.exec(type.type);
    if (winback) {
      const stepNumber = Number(winback[1]);
      return job({
        subject: winbackSubject({ stepNumber, planName: null }),
        blocks: buildWinbackEmail({ stepNumber, customerName: null, planName: null, senderName, resubscribeUrl: standIn }),
        footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
      });
    }
    if (type.type === "expiring_card") {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const card = { cardBrand: "Visa", cardLast4: "4242" };
      return job({
        subject: expiringCardSubject(card),
        blocks: buildExpiringCardEmail({
          ...card,
          customerName: null,
          expiresMonth: next.getUTCMonth() + 1,
          expiresYear: next.getUTCFullYear(),
          senderName,
          updateUrl: standIn,
        }),
        footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
      });
    }
    if (type.type === "expiring_card_no_payment_method") {
      // The trial-end month stands in for the row's month and year, as on a
      // real 'no_payment_method' alert.
      const trialEnd = new Date(now.getTime() + 3 * DAY_MS);
      return job({
        subject: noPaymentMethodSubject(),
        blocks: buildNoPaymentMethodEmail({
          customerName: null,
          trialEndsMonth: trialEnd.getUTCMonth() + 1,
          trialEndsYear: trialEnd.getUTCFullYear(),
          senderName,
          updateUrl: standIn,
        }),
        footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
      });
    }
    if (type.type === "recovery_resend") {
      // The manual resend sends the step's stored subject and body with its own
      // footer line (manual-action-deps.server.ts); the first email's template
      // stands in for the stored copy.
      const copy = buildTemplateEmail({
        merchantName: senderName ?? "your subscription",
        declineCategory: "soft",
        amountFormatted: SAMPLE_AMOUNT,
        updateUrl: standIn,
        stepType: "email_day1",
        customerName: null,
        senderName,
      });
      return job({ ...copy, footerNote: resendFooterNote(senderName, now.getUTCFullYear()) });
    }
    if (type.type === "settings_test") {
      // The merchant's own preview, built by the function its control uses: a
      // "preview" job, with Recova's preview footer and no unsubscribe (E3).
      return {
        channel: "job",
        audience: "preview",
        job: buildTestEmailJob({
          accountId: merchant.accountId,
          to,
          senderName,
          replyTo: merchant.replyTo,
          baseUrl,
          template: base.template,
          idempotencyKey: base.idempotencyKey,
        }),
      };
    }
  }

  if (type.audience === "merchant") {
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
    const sample = { amountCents: SAMPLE_AMOUNT_CENTS, currency: SAMPLE_CURRENCY, customerLabel: SAMPLE_CUSTOMER_LABEL };
    const paymentUrl = `${baseUrl}/recovery/payments`;
    if (type.type === "weekly_digest") {
      // The digest's own content function and its own audience (E23): the
      // platform's From, Recova's footer sentence, and a real signed digest
      // unsubscribe with the postal address, as the cron sends it. Signed for
      // the test inbox, which is not the merchant's notification address, so
      // following it reports the link as expired and switches nothing off.
      // Its unsubscribe is signed for an account, so it needs a merchant, as
      // customer mail does.
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
            recoveredRevenueCents: 69300,
            atRiskRevenueCents: 118800,
            activeCount: 5,
            emailsSent: 31,
            winBackCount: 2,
            expiringCardCount: 3,
            openDisputeCount: 1,
            openDisputeCents: 4900,
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
      // The notifier's own content function (E10): the notice and its footer.
      return merchantJob(recoveryNotifyContent({ ...sample, declineCategory: "soft" }, paymentUrl, now));
    }
    if (type.type === "sequence_complete") {
      // The notifier's own content function (E11): the notice and its footer.
      return merchantJob(sequenceCompleteContent(sample, paymentUrl, now));
    }
    if (type.type === "alert_threshold") {
      // The alert's own content function (E21).
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
      // The alert's own content function (E22).
      return merchantJob(criticalCustomersContent(2, baseUrl, now));
    }
    if ((DISPUTE_TYPES as readonly string[]).includes(type.type)) {
      // The notices' own content functions (E16, E17, E19, E20 and the
      // auto-submitted notice) on a sample
      // dispute. Every button goes to the disputes list: the sample has no row.
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
              triage: { recommendation: "fight", confidence: 78, reasoning: "Delivery was confirmed by the carrier." },
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
      // The report's own builder (E24) on a sample audit, with a first month
      // and a prior one to compare against.
      const email = buildMonthlyAuditEmail({
        result: sampleAuditResult(now),
        summary: "A sample month: recoveries are up, and three cards expire soon.",
        runId: "sample",
        baseUrl,
        comparisons: compareTotals([{ currency: SAMPLE_CURRENCY, cents: 69300 }], [{ currency: SAMPLE_CURRENCY, cents: 41500 }]),
      });
      return merchantJob({
        fromName: MONTHLY_AUDIT_FROM_NAME,
        ...email,
        footerNote: recoveryFooterNote(MONTHLY_AUDIT_FROM_NAME, now.getUTCFullYear()),
      });
    }
    if (type.type === "team_invite") {
      // The invite's own job builder (E2), with no token in the link.
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
  }

  if (type.type === "sign_in_link") {
    return { channel: "rendered", to, rendered: renderSignInLinkEmail(to, `${baseUrl}/login`) };
  }
  // The operations mail, built by its own functions and rendered for the
  // caller's inbox instead of the support inbox (SUPPORT_EMAIL).
  if (type.type === "cron_failure") {
    const message = buildFailureAlertEmail(
      {
        cronName: "recovery-tick",
        runId: "run_sample",
        error: "Sample failure: D1_ERROR: database is locked",
        stack: null,
        lastSuccessAt: new Date(now.getTime() - 3_600_000),
      },
      now,
    );
    return { channel: "rendered", to, rendered: renderCronAlertEmail(to, message, baseUrl, now) };
  }
  if (type.type === "cron_stale") {
    const message = buildStaleAlertEmail(
      { cronName: "retention-sweep", lastRunAt: new Date(now.getTime() - 3 * 86_400_000), reason: "overdue", schedule: CRON_SCHEDULE_DAILY },
      now,
    );
    return { channel: "rendered", to, rendered: renderCronAlertEmail(to, message, baseUrl, now) };
  }
  if (type.type === "dead_letter_alert") {
    return { channel: "transactional", to, ...deadLetterAlertMessage({ written: 2, failed: 0 }, now) };
  }
  throw new Error(`no builder for ${type.type}`);
}

// ---------------------------------------------------------------------------
// Preview and send
// ---------------------------------------------------------------------------

export interface EmailPreview {
  type: string;
  audience: AdminEmailAudience;
  from: string;
  to: string;
  reply_to: string | null;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** The message the send module would hand the binding, without sending. Pure. */
export function previewAdminEmail(env: Env, type: AdminEmailType, prepared: PreparedEmail): EmailPreview {
  const message =
    prepared.channel === "job"
      ? buildEmailMessage({ ...prepared.job }, env.BETTER_AUTH_URL ?? "")
      : prepared.channel === "rendered"
        ? buildRenderedTransactionalMessage({ to: prepared.to, rendered: prepared.rendered })
        : buildTransactionalMessage(prepared);
  return {
    type: type.type,
    audience: type.audience,
    from: message.from,
    to: message.to,
    reply_to: message.replyTo ?? null,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers ?? {},
  };
}

type AdminSendStatus = "sent" | "suppressed" | "failed";

export interface AdminSendResult {
  type: string;
  status: AdminSendStatus;
  provider_message_id: string | null;
  error: string | null;
}

/** Send one prepared email through the send module. Never throws. */
export async function sendAdminEmail(env: Env, type: AdminEmailType, prepared: PreparedEmail): Promise<AdminSendResult> {
  const done = (status: AdminSendStatus, providerMessageId: string | null = null, error: string | null = null): AdminSendResult => ({
    type: type.type,
    status,
    provider_message_id: providerMessageId,
    error,
  });
  try {
    if (prepared.channel === "job") {
      // The suppression gate every real customer and merchant send passes.
      if (await isSuppressed(env, prepared.job.to)) return done("suppressed");
      const { providerMessageId } = await sendEmail(env, prepared.job);
      return done("sent", providerMessageId);
    }
    if (prepared.channel === "transactional") {
      const { providerMessageId } = await sendTransactionalEmail(env, prepared);
      return done("sent", providerMessageId);
    }
    const outcome = await sendRenderedTransactionalEmail(env, { to: prepared.to, rendered: prepared.rendered, redact: [prepared.to] });
    return outcome.status === "sent"
      ? done("sent", outcome.providerMessageId)
      : done("failed", null, outcome.error ?? outcome.reason);
  } catch (err) {
    return done("failed", null, err instanceof Error ? err.message : String(err));
  }
}
