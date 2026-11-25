import { appOrigin } from "~/lib/app-origin";
import { and, eq } from "drizzle-orm";

import { accounts, disputeApprovals, disputes, getDb, stripeConnections } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";

import {
  autoSubmittedNotice,
  createdNotice,
  DISPUTE_AUTO_SUBMITTED_TEMPLATE,
  DISPUTE_CREATED_TEMPLATE,
  DISPUTE_NOTICE_FROM_NAME,
  DISPUTE_OUTCOME_TEMPLATE,
  DISPUTE_REMINDER_TEMPLATE,
  disputeNoticeFooterNote,
  nextDisputeBillingRun,
  type NoticeMail,
  noticeCustomerLabel,
  outcomeNotice,
  reminderKey,
  reminderNotice,
  type ReminderBucket,
} from "./notices";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// THE SENDERS for the merchant's dispute notices. The words and rules are in
// ./notices.ts; this reads the rows and hands each notice to processEmailJob,
// the one send path, so suppression, the per-account live-send gate and the
// email_sends claim all apply.
//
// A redelivered webhook or a second cron tick finds the claim and sends
// nothing.

type DisputeNoticeSkip = "not_found" | "no_recipient" | "paused" | "not_resolved";

export type DisputeNoticeOutcome =
  | { kind: "sent"; result: EmailJobResult }
  | { kind: "skipped"; reason: DisputeNoticeSkip }
  | { kind: "error"; message: string };

interface NoticeRow {
  id: string;
  amountCents: number;
  currency: string;
  reason: string;
  customerName: string | null;
  customerEmail: string | null;
  evidenceDeadline: Date | null;
  triageRecommendation: string | null;
  triageConfidence: number | null;
  triageReasoning: string | null;
  state: string;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  resolvedFeeCents: number | null;
  resolvedFeeCurrency: string | null;
  notificationEmail: string | null;
  processingPaused: boolean;
  billingExempt: boolean;
  /**
   * Whether the auto-submit job would submit for this account (its reader's own
   * conditions: the setting on, a recorded opt-in, Disputes on).
   */
  autoSubmit: boolean;
  senderName: string | null;
}

async function loadNoticeRow(
  env: Env,
  accountId: string,
  disputeId: string,
): Promise<NoticeRow | null> {
  const [row] = await getDb(env)
    .select({
      id: disputes.id,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
      reason: disputes.reason,
      customerName: disputes.customerName,
      customerEmail: disputes.customerEmail,
      evidenceDeadline: disputes.evidenceDeadline,
      triageRecommendation: disputes.triageRecommendation,
      triageConfidence: disputes.triageConfidence,
      triageReasoning: disputes.triageReasoning,
      state: disputes.state,
      submittedAt: disputes.submittedAt,
      resolvedAt: disputes.resolvedAt,
      resolvedFeeCents: disputes.resolvedFeeCents,
      resolvedFeeCurrency: disputes.resolvedFeeCurrency,
      notificationEmail: accounts.notificationEmail,
      processingPaused: accounts.processingPaused,
      billingExempt: accounts.billingExempt,
      autoSubmitSetting: accounts.disputeAutoSubmit,
      autoSubmitAt: accounts.disputeAutoSubmitAt,
      disputesEnabled: accounts.disputesEnabled,
      senderName: stripeConnections.senderName,
    })
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .leftJoin(stripeConnections, eq(stripeConnections.id, disputes.stripeConnectionId))
    .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId)))
    .limit(1);
  if (!row) return null;
  const { autoSubmitSetting, autoSubmitAt, disputesEnabled, ...rest } = row;
  return {
    ...rest,
    autoSubmit: autoSubmitSetting === true && autoSubmitAt != null && disputesEnabled,
  };
}

export function appUrl(env: Env, path: string): string {
  return `${appOrigin(env)}${path}`;
}

/**
 * Hand one merchant notice to the send path. Also used by the early fraud
 * warning notice (./fraud-warnings.server.ts), which is the same kind of mail.
 */
export async function send(
  env: Env,
  accountId: string,
  to: string,
  content: NoticeMail & { footerNote: string },
  template: string,
  idempotencyKey: string,
  cronRunId: string | null,
): Promise<DisputeNoticeOutcome> {
  const common = {
    accountId,
    to,
    fromName: DISPUTE_NOTICE_FROM_NAME,
    subject: content.subject,
    template,
    // Platform-to-merchant mail: no unsubscribe, no postal footer (see
    // EmailAudience).
    audience: "merchant" as const,
    unsubscribeToken: "",
    physicalAddress: "",
    idempotencyKey,
    cronRunId,
  };
  const result = await processEmailJob(
    env,
    { ...common, notice: content.notice, footerNote: content.footerNote },
    null,
  );
  return { kind: "sent", result };
}

function failed(
  scope: string,
  ctx: { accountId: string; disputeId: string },
  err: unknown,
): DisputeNoticeOutcome {
  const message = errorMessage(err);
  console.error(
    `dispute ${scope} notice failed for account ${ctx.accountId} dispute ${ctx.disputeId}:`,
    message,
  );
  return { kind: "error", message };
}

interface RowNotice {
  /** Why this row gets no notice, checked before the recipient. */
  skip?: (row: NoticeRow) => DisputeNoticeSkip | null;
  build: (row: NoticeRow) => NoticeMail | Promise<NoticeMail>;
  template: string;
  key: (row: NoticeRow) => string;
}

/** Load the dispute's notice row, apply the notice's skips, and hand its mail to `send`. */
async function sendRowNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string },
  cronRunId: string | null,
  scope: string,
  spec: RowNotice,
): Promise<DisputeNoticeOutcome> {
  try {
    const row = await loadNoticeRow(env, ctx.accountId, ctx.disputeId);
    if (!row) return { kind: "skipped", reason: "not_found" };
    const reason = spec.skip?.(row);
    if (reason) return { kind: "skipped", reason };
    if (!row.notificationEmail) return { kind: "skipped", reason: "no_recipient" };
    const notice = {
      ...(await spec.build(row)),
      footerNote: disputeNoticeFooterNote(row.senderName, new Date().getUTCFullYear()),
    };
    return await send(
      env,
      ctx.accountId,
      row.notificationEmail,
      notice,
      spec.template,
      spec.key(row),
      cronRunId,
    );
  } catch (err) {
    return failed(scope, ctx, err);
  }
}

export function sendDisputeCreatedNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string },
): Promise<DisputeNoticeOutcome> {
  return sendRowNotice(env, ctx, null, "created", {
    skip: (row) => (row.processingPaused ? "paused" : null),
    build: (row) =>
      createdNotice({
        amountCents: row.amountCents,
        currency: row.currency,
        customerLabel: noticeCustomerLabel(row.customerName, row.customerEmail),
        reason: row.reason,
        evidenceDeadline: row.evidenceDeadline,
        autoSubmit: row.autoSubmit,
        disputeUrl: appUrl(env, `/disputes/${row.id}`),
        triage: row.triageRecommendation
          ? {
              recommendation: row.triageRecommendation,
              confidence: row.triageConfidence,
              reasoning: row.triageReasoning,
            }
          : null,
      }),
    template: DISPUTE_CREATED_TEMPLATE,
    key: (row) => `dispute-created:${row.id}`,
  });
}

export function sendDisputeOutcomeNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string },
): Promise<DisputeNoticeOutcome> {
  return sendRowNotice(env, ctx, null, "outcome", {
    skip: (row) =>
      row.state !== "resolved_won" && row.state !== "resolved_lost" ? "not_resolved" : null,
    build: (row) =>
      outcomeNotice({
        won: row.state === "resolved_won",
        amountCents: row.amountCents,
        currency: row.currency,
        reason: row.reason,
        foxhoundSubmitted: row.submittedAt != null,
        // A billing-exempt account is never invoiced
        // (accountBillingEligibleCondition).
        feeCents: row.billingExempt ? null : row.resolvedFeeCents,
        feeCurrency: row.resolvedFeeCurrency ?? row.currency,
        // A paused account is skipped by the billing run until it resumes, so
        // no date is promised.
        invoiceDate: row.processingPaused
          ? null
          : nextDisputeBillingRun(row.resolvedAt ?? new Date()),
        listUrl: appUrl(env, "/disputes/dashboard"),
      }),
    template: DISPUTE_OUTCOME_TEMPLATE,
    key: (row) => `dispute-outcome:${row.id}`,
  });
}

/**
 * The won notice again, once a fee priced late is stored. The first won notice
 * went out without a fee sentence because the cap could not be converted at
 * resolution, and a fee the merchant was never told is never billed.
 */
export function sendDisputeFeeNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string; pricedAt: Date; cronRunId: string | null },
): Promise<DisputeNoticeOutcome> {
  return sendRowNotice(env, ctx, ctx.cronRunId, "fee", {
    skip: (row) =>
      row.state !== "resolved_won" || row.submittedAt == null || row.resolvedFeeCents == null
        ? "not_resolved"
        : null,
    build: (row) =>
      outcomeNotice({
        won: true,
        amountCents: row.amountCents,
        currency: row.currency,
        reason: row.reason,
        foxhoundSubmitted: true,
        feeCents: row.billingExempt ? null : row.resolvedFeeCents,
        feeCurrency: row.resolvedFeeCurrency ?? row.currency,
        // The first run at or after the pricing, which is the first run that
        // can bill it.
        invoiceDate: row.processingPaused ? null : nextDisputeBillingRun(ctx.pricedAt),
        listUrl: appUrl(env, "/disputes/dashboard"),
      }),
    template: DISPUTE_OUTCOME_TEMPLATE,
    key: (row) => `dispute-fee:${row.id}`,
  });
}

/**
 * A dispute_approvals row exists for the dispute, pinned to the account. The
 * cron selects only unsubmitted disputes, so a row here is an approval Stripe
 * has not confirmed.
 */
async function hasStandingApproval(
  env: Env,
  accountId: string,
  disputeId: string,
): Promise<boolean> {
  const rows = await getDb(env)
    .select({ id: disputeApprovals.id })
    .from(disputeApprovals)
    .where(
      and(eq(disputeApprovals.disputeId, disputeId), eq(disputeApprovals.accountId, accountId)),
    )
    .limit(1);
  return rows.length > 0;
}

export function sendDisputeReminderNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string; bucket: ReminderBucket; cronRunId: string | null },
): Promise<DisputeNoticeOutcome> {
  return sendRowNotice(env, ctx, ctx.cronRunId, "reminder", {
    build: async (row) =>
      reminderNotice({
        approved: await hasStandingApproval(env, ctx.accountId, row.id),
        autoSubmit: row.autoSubmit,
        amountCents: row.amountCents,
        currency: row.currency,
        customerLabel: noticeCustomerLabel(row.customerName, row.customerEmail),
        reason: row.reason,
        daysLeft: ctx.bucket.daysLeft,
        disputeUrl: appUrl(env, `/disputes/${row.id}`),
      }),
    template: DISPUTE_REMINDER_TEMPLATE,
    key: (row) => reminderKey(ctx.bucket.eventType, row.id),
  });
}

function autoSubmittedKey(disputeId: string): string {
  return `dispute-auto-submitted:${disputeId}`;
}

export function sendDisputeAutoSubmittedNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string; cronRunId: string | null },
): Promise<DisputeNoticeOutcome> {
  return sendRowNotice(env, ctx, ctx.cronRunId, "auto-submitted", {
    build: (row) =>
      autoSubmittedNotice({
        amountCents: row.amountCents,
        currency: row.currency,
        customerLabel: noticeCustomerLabel(row.customerName, row.customerEmail),
        reason: row.reason,
        disputeUrl: appUrl(env, `/disputes/${row.id}`),
      }),
    template: DISPUTE_AUTO_SUBMITTED_TEMPLATE,
    key: (row) => autoSubmittedKey(row.id),
  });
}
