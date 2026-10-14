import { and, eq } from "drizzle-orm";

import { accounts, failedPayments, getDb } from "~/db";
import type { Db } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";

// THE MERCHANT RECOVERY NOTIFICATION. Ported from legacy's
// app/api/webhooks/stripe/route.ts (blob `deb585e4`, 47,093 bytes), the
// "Notify merchant" block inside handlePaymentSucceeded.
//
// TRIGGER: the same event, at the same point. Legacy sends it only after its
// active-to-recovered transition claim returns rows, so a replayed webhook
// affects zero rows, returns early, and sends nothing. Foxhound's equivalent
// claim is `executeMoneyWrite`'s `applied` flag, which is false on a replay
// because the outcomes idempotency key collides and the whole batch rolls back.
// The caller passes that flag; this module is only ever reached when the
// recovery genuinely just transitioned.
//
// IT RUNS AFTER THE MONEY WRITE HAS COMMITTED AND CHANGES NOTHING ABOUT IT.
// recordOutcome and the recovery batch are untouched: this reads three rows and
// sends mail. Legacy does the same, in a try/catch that logs and continues, so
// a mail failure never unwinds a recorded recovery.
//
// NO UNSUBSCRIBE AND NO POSTAL FOOTER, because this is platform-to-merchant
// mail about the merchant's own account. Legacy sends it with neither. The job
// declares `audience: "merchant"`, which is what scopes CAN-SPAM off; the guard
// still fires for anything that omits the field.

export const RECOVERY_NOTIFY_TEMPLATE = "merchant_recovery_notify";

/** Legacy's From identity for this message: the PLATFORM, never the merchant's
 *  own sender name. Legacy uses `FROM_RECOVERY` ("Recova <recovery@...>") and
 *  wraps the body with the sender name "Recova", both hardcoded. It reads
 *  `sender_name` into the row it builds and then never uses it. */
export const RECOVERY_NOTIFY_FROM_NAME = "Foxhound";

export interface RecoveryNotificationContext {
  accountId: string;
  failedPaymentId: string;
}

/**
 * Why nothing was sent, or what happened when something was.
 *
 * THE `skipped` REASONS ARE THE POINT. An earlier shape returned `null` for
 * every non-send, which made a deliberate refusal indistinguishable from a
 * crash the catch had swallowed: deleting the recipient guard threw on
 * `null.trim()`, the catch returned null, and the plant that asserted null
 * passed. A refusal now names itself and an error names itself.
 */
export type RecoveryNotificationOutcome =
  | { kind: "sent"; result: EmailJobResult }
  | { kind: "skipped"; reason: "not_found" | "no_recipient" | "disabled" }
  | { kind: "error"; message: string };

interface NotificationData {
  notificationEmail: string;
  customerLabel: string;
  amountCents: number;
  currency: string;
  declineCategory: string;
}

/**
 * Legacy's money formatting for this email, verbatim:
 * `Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'usd' })`
 * over `amount_cents / 100`. Note the falsy-currency coercion, which is legacy's.
 */
export function formatNotifyAmount(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "usd",
  }).format(amountCents / 100);
}

/** Legacy's subject line, verbatim. */
export function recoveryNotifySubject(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
}): string {
  return `Payment recovered: ${formatNotifyAmount(data.amountCents, data.currency)} from ${data.customerLabel}`;
}

/**
 * Legacy's body, verbatim in wording and order. The only change is the link
 * target: legacy points at `${APP_URL}/payments/${id}`, Foxhound's route for the
 * same page is `/recovery/payments/:id`.
 *
 * PLAIN SEMANTIC HTML, no inline colours: legacy styles the button from its
 * EMAIL_COLORS module, which Foxhound does not have (the wall buildDigestEmail
 * and the S33 preview banner both hit), and check-tokens fails the build on raw
 * hex. The anchor stays an anchor.
 *
 * The title line is a real heading (J02 review): the email frame no longer
 * promotes an all-bold paragraph to a heading, so the same words that were
 * `<p><strong>` are now `<h1>`, and render as the mail's title.
 */
export function recoveryNotifyBody(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
  declineCategory: string;
  paymentUrl: string;
}): string {
  const amount = formatNotifyAmount(data.amountCents, data.currency);
  return (
    `<h1>Payment recovered.</h1>` +
    `<p>${data.customerLabel} just paid <strong>${amount}</strong>. ` +
    `Foxhound recovered it automatically after a ${data.declineCategory} decline.</p>` +
    `<p><a href="${data.paymentUrl}">View payment</a></p>`
  );
}

/**
 * The recipient and the toggle, read exactly as legacy reads them.
 *
 * RECIPIENT: `accounts.notification_email` ONLY. Legacy has NO fallback to the
 * owner's login address: its guard is `if (notifyEmail && ...)`, so an account
 * that never set one is simply not notified. Reproduced rather than improved,
 * because inventing a fallback would email an address the merchant never
 * nominated for this.
 *
 * TOGGLE: `recovery_notifications_enabled !== false`, so NULL is ON. That is
 * legacy's own reading and 337 binding 3's per-column rule; 315's NULL-is-OFF
 * belongs to `audit_auto_run` and does not generalise.
 */
export async function loadNotificationData(
  db: Db,
  ctx: RecoveryNotificationContext,
): Promise<NotificationData | { skipped: "not_found" | "no_recipient" | "disabled" }> {
  const [accountRows, paymentRows] = await Promise.all([
    db
      .select({
        notificationEmail: accounts.notificationEmail,
        enabled: accounts.recoveryNotificationsEnabled,
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
        declineCategory: failedPayments.declineCategory,
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
    // Legacy: `customer_name || customer_email`.
    customerLabel: payment.customerName || payment.customerEmail,
    amountCents: payment.amountCents,
    currency: payment.currency,
    declineCategory: payment.declineCategory,
  };
}

/**
 * Send the notification for one just-recorded recovery.
 *
 * Goes through `processEmailJob`, the same function the dunning path uses, so
 * the suppression gate, the per-account live-send gate and the `email_sends`
 * row all apply. That is also where a DEMO account refuses: `liveSendsEnabled`
 * reads false for it and the block is logged rather than silent, at the same
 * gate every other send meets.
 *
 * NEVER THROWS. Legacy wraps this whole block in a try/catch that logs to
 * Sentry and continues, because the recovery and its fee are already committed
 * and a mail failure must not unwind them or fail the webhook. Returns the
 * result for the caller to log, or null when nothing was owed.
 */
export async function sendRecoveryNotification(
  env: Env,
  ctx: RecoveryNotificationContext,
): Promise<RecoveryNotificationOutcome> {
  try {
    const db = getDb(env);
    const data = await loadNotificationData(db, ctx);
    if ("skipped" in data) return { kind: "skipped", reason: data.skipped };

    const baseUrl = env.BETTER_AUTH_URL ?? "";
    const bodyHtml = recoveryNotifyBody({
      amountCents: data.amountCents,
      currency: data.currency,
      customerLabel: data.customerLabel,
      declineCategory: data.declineCategory,
      paymentUrl: `${baseUrl}/recovery/payments/${ctx.failedPaymentId}`,
    });

    const result = await processEmailJob(
      env,
      {
        accountId: ctx.accountId,
        to: data.notificationEmail,
        fromName: RECOVERY_NOTIFY_FROM_NAME,
        subject: recoveryNotifySubject(data),
        bodyHtml,
        template: RECOVERY_NOTIFY_TEMPLATE,
        // Platform-to-merchant mail. See EmailAudience.
        audience: "merchant",
        unsubscribeToken: "",
        physicalAddress: "",
        // Stable per RECOVERY, not per delivery: the caller only reaches this
        // when the money write applied, and that already collapses replays.
        idempotencyKey: `recovery-notify:${ctx.failedPaymentId}`,
        cronRunId: null,
      },
      null,
    );
    return { kind: "sent", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `recovery notification failed for account ${ctx.accountId} payment ${ctx.failedPaymentId}:`,
      message,
    );
    return { kind: "error", message };
  }
}
