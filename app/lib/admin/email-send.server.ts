import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, stripeConnections } from "~/db/schema";
import { renderSignInLinkEmail } from "~/lib/auth/send-auth-email";
import {
  buildEmailMessage,
  buildRenderedTransactionalMessage,
  sendEmail,
  sendRenderedTransactionalEmail,
} from "~/lib/email/send";
import { isSuppressed } from "~/lib/email/suppression";
import type { EmailNotice } from "~/lib/email/templates";
import type { EmailAudience, OutboundEmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recoveryFooterNote } from "~/lib/engine/execute-step";
import { digestContent } from "~/lib/recovery/digest-email";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import { buildExpiringCardEmail, expiringCardSubject } from "~/lib/recovery/expiring-card-email";
import { recoveryNotifyContent } from "~/lib/recovery/merchant-notification.server";
import { sequenceCompleteContent } from "~/lib/recovery/sequence-complete-notification.server";
import { buildWinbackEmail, winbackSubject } from "~/lib/recovery/winback-email";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";
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
// sendEmail for customer and merchant mail, the two transactional senders for
// platform mail. Customer and merchant mail honours suppression, as
// processEmailJob does, but skips the per-account live-send gate, because that
// gate exists to keep a merchant's customers from being mailed before the
// merchant is switched on, and this mail goes only to the caller's own inbox.
//
// LEFT OUT, and why. Dispute notices and team invites: Foxhound sends no such
// email (an invite is a link shown on /settings/team). The monthly audit: it
// needs a whole audit result to render, and a sample one is its own job. The
// cron failure and stale alerts: operational mail to the support inbox, not a
// merchant or customer email.

export type AdminEmailAudience = "customer" | "merchant" | "platform";

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

export const ADMIN_EMAIL_TYPES: readonly AdminEmailType[] = [
  ...Object.entries(RECOVERY_STEPS).map(([type, step]) => ({
    type,
    audience: "customer" as const,
    description: `The ${step.label} failed-payment recovery email a merchant's customer gets, from the merchant's sender name with its Reply-To.`,
  })),
  ...[1, 2, 3].map((n) => ({
    type: `winback_step${n}`,
    audience: "customer" as const,
    description: `Win-back email ${n} of 3, sent to a customer who cancelled, from the merchant's sender name with its Reply-To.`,
  })),
  {
    type: "expiring_card",
    audience: "customer",
    description: "The expiring-card warning a merchant's customer gets before their card expires.",
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
    type: "sign_in_link",
    audience: "platform",
    description: "The email with a sign-in link. Its button goes to the sign-in page with no token, so it signs nobody in.",
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
  | { channel: "rendered"; to: string; rendered: Rendered };

// Sample data, the same sample the merchant's Send test email uses where it has one.
const SAMPLE_AMOUNT_CENTS = 9900;
const SAMPLE_AMOUNT = "$99.00";
const SAMPLE_CURRENCY = "usd";
const SAMPLE_CUSTOMER_LABEL = "Sample Customer";

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
      content: { subject: string; fromName: string; footerNote?: string } & ({ bodyHtml: string } | { notice: EmailNotice }),
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
      const flags = { now, intelligenceActive: false, disputesActive: true };
      return {
        channel: "job",
        audience: "digest",
        job: {
          accountId: merchant.accountId,
          to,
          ...digestContent({
            ...flags,
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
  }

  if (type.type === "sign_in_link") {
    return { channel: "rendered", to, rendered: renderSignInLinkEmail(to, `${baseUrl}/login`) };
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
      : buildRenderedTransactionalMessage({ to: prepared.to, rendered: prepared.rendered });
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

export type AdminSendStatus = "sent" | "suppressed" | "failed";

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
    const outcome = await sendRenderedTransactionalEmail(env, { to: prepared.to, rendered: prepared.rendered, redact: [prepared.to] });
    return outcome.status === "sent"
      ? done("sent", outcome.providerMessageId)
      : done("failed", null, outcome.error ?? outcome.reason);
  } catch (err) {
    return done("failed", null, err instanceof Error ? err.message : String(err));
  }
}
