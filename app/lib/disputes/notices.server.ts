import { and, eq } from "drizzle-orm";

import { accounts, disputes, getDb } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";

import {
  createdNotice,
  DISPUTE_CREATED_TEMPLATE,
  DISPUTE_NOTICE_FROM_NAME,
  DISPUTE_OUTCOME_TEMPLATE,
  DISPUTE_REMINDER_TEMPLATE,
  nextDisputeBillingRun,
  noticeCustomerLabel,
  outcomeNotice,
  reminderKey,
  reminderNotice,
  type RenderedNotice,
  type ReminderBucket,
} from "./notices";

// THE SENDERS for the merchant's dispute notices (J06). The words and rules are
// in ./notices.ts; this reads the rows and hands each notice to processEmailJob,
// the one send path, so suppression, the per-account live-send gate and the
// email_sends claim all apply.
//
// RECIPIENT: accounts.notification_email ONLY, as Recova's
// ensureNotificationTarget, and as RULES.md 3.16 requires of a merchant notice.
// No fallback to a login address: an account that never named one is not
// notified, and the skip says so.
//
// ONCE PER DISPUTE, AT THE SEND LAYER. Each notice's idempotency key is stable
// per dispute (and per band for a reminder), so the email_sends claim is the
// once-only mark Recova kept in outcome_notified_at and in its reminder outcome
// rows. A redelivered webhook or a second cron tick finds the claim and sends
// nothing.
//
// THIS MODULE WRITES NOTHING (RULES.md 3.2): no outcome, no stamp. The callers
// write those after a send, through the money-write Durable Object.
//
// NEVER THROWS. A notice is sent after the money write has committed, and a mail
// failure must not unwind a dispute or fail a webhook, as Recova's try/catch
// around every one of these. A refusal names itself and an error names itself
// (RULES.md 3.16), never a null.

export type DisputeNoticeSkip = "not_found" | "no_recipient" | "paused" | "not_resolved";

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
  state: string;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  resolvedFeeCents: number | null;
  resolvedFeeCurrency: string | null;
  notificationEmail: string | null;
  processingPaused: boolean;
  billingExempt: boolean;
}

/** The dispute and its account's notice settings, pinned to the account. */
async function loadNoticeRow(env: Env, accountId: string, disputeId: string): Promise<NoticeRow | null> {
  const rows = await getDb(env)
    .select({
      id: disputes.id,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
      reason: disputes.reason,
      customerName: disputes.customerName,
      customerEmail: disputes.customerEmail,
      evidenceDeadline: disputes.evidenceDeadline,
      state: disputes.state,
      submittedAt: disputes.submittedAt,
      resolvedAt: disputes.resolvedAt,
      resolvedFeeCents: disputes.resolvedFeeCents,
      resolvedFeeCurrency: disputes.resolvedFeeCurrency,
      notificationEmail: accounts.notificationEmail,
      processingPaused: accounts.processingPaused,
      billingExempt: accounts.billingExempt,
    })
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .where(and(eq(disputes.id, disputeId), eq(disputes.accountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

function appUrl(env: Env, path: string): string {
  return `${env.BETTER_AUTH_URL ?? ""}${path}`;
}

async function send(
  env: Env,
  accountId: string,
  to: string,
  notice: RenderedNotice,
  template: string,
  idempotencyKey: string,
  cronRunId: string | null,
): Promise<DisputeNoticeOutcome> {
  const result = await processEmailJob(
    env,
    {
      accountId,
      to,
      fromName: DISPUTE_NOTICE_FROM_NAME,
      subject: notice.subject,
      bodyHtml: notice.bodyHtml,
      template,
      // Platform-to-merchant mail: no unsubscribe, no postal footer
      // (RULES.md 3.16; see EmailAudience).
      audience: "merchant",
      unsubscribeToken: "",
      physicalAddress: "",
      idempotencyKey,
      cronRunId,
    },
    null,
  );
  return { kind: "sent", result };
}

function failed(scope: string, ctx: { accountId: string; disputeId: string }, err: unknown): DisputeNoticeOutcome {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`dispute ${scope} notice failed for account ${ctx.accountId} dispute ${ctx.disputeId}:`, message);
  return { kind: "error", message };
}

/**
 * The new-dispute notice, sent once the intake batch has committed. Recova
 * returns before its email when the account is paused, so this does too.
 */
export async function sendDisputeCreatedNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string },
): Promise<DisputeNoticeOutcome> {
  try {
    const row = await loadNoticeRow(env, ctx.accountId, ctx.disputeId);
    if (!row) return { kind: "skipped", reason: "not_found" };
    if (row.processingPaused) return { kind: "skipped", reason: "paused" };
    if (!row.notificationEmail) return { kind: "skipped", reason: "no_recipient" };
    const notice = createdNotice({
      amountCents: row.amountCents,
      currency: row.currency,
      customerLabel: noticeCustomerLabel(row.customerName, row.customerEmail),
      reason: row.reason,
      evidenceDeadline: row.evidenceDeadline,
      disputeUrl: appUrl(env, `/disputes/${row.id}`),
    });
    return await send(
      env,
      ctx.accountId,
      row.notificationEmail,
      notice,
      DISPUTE_CREATED_TEMPLATE,
      `dispute-created:${row.id}`,
      null,
    );
  } catch (err) {
    return failed("created", ctx, err);
  }
}

/**
 * The won or lost notice, from the dispute's RESOLVED state rather than the
 * event, so a dispute the merchant accepted (resolved lost before Stripe's
 * closing event arrives) is told the same as Recova told it. Recova sends it
 * whether or not the account is paused, and so does this.
 */
export async function sendDisputeOutcomeNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string },
): Promise<DisputeNoticeOutcome> {
  try {
    const row = await loadNoticeRow(env, ctx.accountId, ctx.disputeId);
    if (!row) return { kind: "skipped", reason: "not_found" };
    if (row.state !== "resolved_won" && row.state !== "resolved_lost") {
      return { kind: "skipped", reason: "not_resolved" };
    }
    if (!row.notificationEmail) return { kind: "skipped", reason: "no_recipient" };
    const notice = outcomeNotice({
      won: row.state === "resolved_won",
      amountCents: row.amountCents,
      currency: row.currency,
      reason: row.reason,
      foxhoundSubmitted: row.submittedAt != null,
      // A billing-exempt account is never invoiced (accountBillingEligibleCondition).
      feeCents: row.billingExempt ? null : row.resolvedFeeCents,
      feeCurrency: row.resolvedFeeCurrency ?? row.currency,
      // A paused account is skipped by the billing run until it resumes, so no
      // date is promised (accountBillingEligibleCondition, PR 149 review).
      invoiceDate: row.processingPaused ? null : nextDisputeBillingRun(row.resolvedAt ?? new Date()),
      listUrl: appUrl(env, "/disputes/dashboard"),
    });
    return await send(
      env,
      ctx.accountId,
      row.notificationEmail,
      notice,
      DISPUTE_OUTCOME_TEMPLATE,
      `dispute-outcome:${row.id}`,
      null,
    );
  } catch (err) {
    return failed("outcome", ctx, err);
  }
}

/** One deadline reminder. The cron chose the dispute and the band. */
export async function sendDisputeReminderNotice(
  env: Env,
  ctx: { accountId: string; disputeId: string; bucket: ReminderBucket; cronRunId: string | null },
): Promise<DisputeNoticeOutcome> {
  try {
    const row = await loadNoticeRow(env, ctx.accountId, ctx.disputeId);
    if (!row) return { kind: "skipped", reason: "not_found" };
    if (!row.notificationEmail) return { kind: "skipped", reason: "no_recipient" };
    const notice = reminderNotice({
      amountCents: row.amountCents,
      currency: row.currency,
      customerLabel: noticeCustomerLabel(row.customerName, row.customerEmail),
      reason: row.reason,
      daysLeft: ctx.bucket.daysLeft,
      disputeUrl: appUrl(env, `/disputes/${row.id}`),
    });
    return await send(
      env,
      ctx.accountId,
      row.notificationEmail,
      notice,
      DISPUTE_REMINDER_TEMPLATE,
      reminderKey(ctx.bucket.eventType, row.id),
      ctx.cronRunId,
    );
  } catch (err) {
    return failed("reminder", ctx, err);
  }
}
