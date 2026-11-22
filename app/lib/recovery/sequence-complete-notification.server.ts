import { appOrigin } from "~/lib/app-origin";
import { and, eq } from "drizzle-orm";

import { accounts, failedPayments, getDb } from "~/db";
import type { Db } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";

import {
  RECOVERY_NOTIFY_FROM_NAME,
  formatNotifyAmount,
  type RecoveryNotificationOutcome,
} from "./merchant-notification.server";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// THE SEQUENCE-COMPLETE NOTIFICATION. IT IS THE MIRROR OF THE RECOVERY NOTIFICATION and shares its
// machinery deliberately: the same From identity, the same amount formatter, the same merchant
// audience, the same discriminated outcome, the same "never throws". A payment the webhook already
// flipped to `recovered` is therefore never a candidate here, so a sequence that ends by recovery
// gets that notice and never this one.

const SEQUENCE_COMPLETE_TEMPLATE = "merchant_sequence_complete";

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

function sequenceCompleteSubject(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
}): string {
  return `Recovery sequence ended: ${formatNotifyAmount(data.amountCents, data.currency)} from ${data.customerLabel} was not recovered`;
}

/**
 * Both sides plan steps out to `email_day30`, and Foxhound's `revoked` schedule is a single email.
 * PLAIN STRINGS, NOT MARKUP.
 */
function sequenceCompleteBody(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
  paymentUrl: string;
}): EmailNotice {
  const amount = formatNotifyAmount(data.amountCents, data.currency);
  return {
    title: "Recovery sequence complete.",
    body: [
      `The recovery sequence for ${data.customerLabel} (${amount}) has ended without a ` +
        `successful payment. You may want to manually reach out or write off this balance.`,
    ],
    action: { label: "View payment", url: data.paymentUrl },
  };
}

/** Everything the notice job says and carries, from the loaded data. */
export function sequenceCompleteContent(
  data: { amountCents: number; currency: string; customerLabel: string },
  paymentUrl: string,
  now: Date,
): { fromName: string; subject: string; notice: EmailNotice; footerNote: string } {
  return {
    fromName: RECOVERY_NOTIFY_FROM_NAME,
    subject: sequenceCompleteSubject(data),
    notice: sequenceCompleteBody({ ...data, paymentUrl }),
    footerNote: recoveryFooterNote(RECOVERY_NOTIFY_FROM_NAME, now.getUTCFullYear()),
  };
}

async function loadSequenceCompleteData(
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
        and(
          eq(failedPayments.id, ctx.failedPaymentId),
          eq(failedPayments.accountId, ctx.accountId),
        ),
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
 * Send the notification for one just-exhausted sequence. NEVER THROWS, and returns a discriminated
 * outcome: a refusal names itself so it cannot be confused with a swallowed crash.
 */
export async function sendSequenceCompleteNotification(
  env: Env,
  ctx: SequenceCompleteContext,
): Promise<RecoveryNotificationOutcome> {
  try {
    const db = getDb(env);
    const data = await loadSequenceCompleteData(db, ctx);
    if ("skipped" in data) return { kind: "skipped", reason: data.skipped };

    const baseUrl = appOrigin(env);
    const result = await processEmailJob(
      env,
      {
        accountId: ctx.accountId,
        to: data.notificationEmail,
        ...sequenceCompleteContent(
          data,
          `${baseUrl}/recovery/payments/${ctx.failedPaymentId}`,
          new Date(),
        ),
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
    const message = errorMessage(err);
    console.error(
      `sequence-complete notification failed for account ${ctx.accountId} payment ${ctx.failedPaymentId}:`,
      message,
    );
    return { kind: "error", message };
  }
}
