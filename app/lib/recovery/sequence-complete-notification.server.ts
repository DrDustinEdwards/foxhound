import { and, eq } from "drizzle-orm";

import { accounts, failedPayments, getDb } from "~/db";
import type { Db } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";

import {
  RECOVERY_NOTIFY_FROM_NAME,
  formatNotifyAmount,
  type RecoveryNotificationOutcome,
} from "./merchant-notification.server";

// THE SEQUENCE-COMPLETE NOTIFICATION. Ported from legacy's
// app/api/cron/process-recovery/route.ts (blob `7015998c`, 19,935 bytes), the
// "Notify merchant - sequence complete, unrecovered" block.
//
// IT IS THE MIRROR OF THE RECOVERY NOTIFICATION and shares its machinery
// deliberately: the same From identity, the same amount formatter, the same
// merchant audience, the same discriminated outcome, the same "never throws".
// What differs is the trigger and the strings.
//
// THE TWO ARE MUTUALLY EXCLUSIVE, on both sides, and not by a rule anyone wrote
// twice: legacy re-reads `status === 'active'` before sending, and Foxhound's
// `queryExhaustedSequences` only selects `status='active'` rows. A payment the
// webhook already flipped to `recovered` is therefore never a candidate here, so
// a sequence that ends by recovery gets that notice and never this one.
//
// TRIGGER: `flipExhaustedSequences`, the tick sweep that runs after the step
// loop. Its flip is conditional on `status='active'`, so it lands exactly once,
// and it now reports WHICH sequences it claimed. This fires once per claim.

export const SEQUENCE_COMPLETE_TEMPLATE = "merchant_sequence_complete";

export interface SequenceCompleteContext {
  accountId: string;
  failedPaymentId: string;
}

interface SequenceCompleteData {
  notificationEmail: string;
  customerLabel: string;
  amountCents: number;
  currency: string;
}

/** Legacy's subject, verbatim. */
export function sequenceCompleteSubject(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
}): string {
  return `Recovery sequence ended: ${formatNotifyAmount(data.amountCents, data.currency)} from ${data.customerLabel} was not recovered`;
}

/**
 * Legacy's body, with ONE deliberate change.
 *
 * LEGACY SAYS "The 7-day recovery sequence" AND ITS OWN SCHEDULES DO NOT RUN
 * SEVEN DAYS. Both sides plan steps out to `email_day30`, and Foxhound's
 * `revoked` schedule is a single email. Legacy's own fallback templates include
 * `email_day14` and `email_day30`, so the sentence was already false where it
 * was written. Dropping the number is a class (c) truthfulness fix, which the
 * PRIME DIRECTIVE exempts from per-item ratification. Every other word is
 * legacy's.
 *
 * PLAIN SEMANTIC HTML, no inline colours: legacy styles its button from
 * EMAIL_COLORS, which Foxhound does not have, and check-tokens fails the build
 * on raw hex.
 */
export function sequenceCompleteBody(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
  paymentUrl: string;
}): string {
  const amount = formatNotifyAmount(data.amountCents, data.currency);
  return (
    `<p><strong>Recovery sequence complete.</strong></p>` +
    `<p>The recovery sequence for ${data.customerLabel} (${amount}) has ended without a ` +
    `successful payment. You may want to manually reach out or write off this balance.</p>` +
    `<p><a href="${data.paymentUrl}">View payment</a></p>`
  );
}

/**
 * The recipient and the toggle, read exactly as legacy reads them:
 * `notification_email` only with no owner fallback, and
 * `sequence_complete_notifications_enabled !== false` so NULL is ON.
 */
export async function loadSequenceCompleteData(
  db: Db,
  ctx: SequenceCompleteContext,
): Promise<SequenceCompleteData | { skipped: "not_found" | "no_recipient" | "disabled" }> {
  const [accountRows, paymentRows] = await Promise.all([
    db
      .select({
        notificationEmail: accounts.notificationEmail,
        enabled: accounts.sequenceCompleteNotificationsEnabled,
      })
      .from(accounts)
      .where(eq(accounts.id, ctx.accountId))
      .limit(1),
    db
      .select({
        customerName: failedPayments.customerName,
        customerEmail: failedPayments.customerEmail,
        amountCents: failedPayments.amountCents,
        currency: failedPayments.currency,
      })
      .from(failedPayments)
      .where(
        and(eq(failedPayments.id, ctx.failedPaymentId), eq(failedPayments.accountId, ctx.accountId)),
      )
      .limit(1),
  ]);

  const account = accountRows[0];
  const payment = paymentRows[0];
  if (!account || !payment) return { skipped: "not_found" };
  if (!account.notificationEmail) return { skipped: "no_recipient" };
  if (account.enabled === false) return { skipped: "disabled" };

  return {
    notificationEmail: account.notificationEmail,
    customerLabel: payment.customerName || payment.customerEmail,
    amountCents: payment.amountCents,
    currency: payment.currency,
  };
}

/**
 * Send the notification for one just-exhausted sequence.
 *
 * Through `processEmailJob`, so the suppression gate, the per-account live-send
 * gate and the `email_sends` row all apply, and a demo account refuses at the
 * gate every other send meets.
 *
 * NEVER THROWS, and returns a discriminated outcome (339): a refusal names
 * itself so it cannot be confused with a swallowed crash.
 */
export async function sendSequenceCompleteNotification(
  env: Env,
  ctx: SequenceCompleteContext,
): Promise<RecoveryNotificationOutcome> {
  try {
    const db = getDb(env);
    const data = await loadSequenceCompleteData(db, ctx);
    if ("skipped" in data) return { kind: "skipped", reason: data.skipped };

    const baseUrl = env.BETTER_AUTH_URL ?? "";
    const result = await processEmailJob(
      env,
      {
        accountId: ctx.accountId,
        to: data.notificationEmail,
        fromName: RECOVERY_NOTIFY_FROM_NAME,
        subject: sequenceCompleteSubject(data),
        bodyHtml: sequenceCompleteBody({
          amountCents: data.amountCents,
          currency: data.currency,
          customerLabel: data.customerLabel,
          paymentUrl: `${baseUrl}/recovery/payments/${ctx.failedPaymentId}`,
        }),
        template: SEQUENCE_COMPLETE_TEMPLATE,
        audience: "merchant",
        unsubscribeToken: "",
        physicalAddress: "",
        idempotencyKey: `sequence-complete:${ctx.failedPaymentId}`,
        cronRunId: null,
      },
      null,
    );
    return { kind: "sent", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `sequence-complete notification failed for account ${ctx.accountId} payment ${ctx.failedPaymentId}:`,
      message,
    );
    return { kind: "error", message };
  }
}
