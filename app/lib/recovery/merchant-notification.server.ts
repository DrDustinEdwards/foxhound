import { appOrigin } from "~/lib/app-origin";
import { and, eq } from "drizzle-orm";

import { accounts, failedPayments, getDb } from "~/db";
import type { Db } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// THE MERCHANT RECOVERY NOTIFICATION. TRIGGER: the same event, at the same point. The caller passes
// that flag; this module is only ever reached when the recovery genuinely just transitioned. IT
// RUNS AFTER THE MONEY WRITE HAS COMMITTED AND CHANGES NOTHING ABOUT IT. recordOutcome and the
// recovery batch are untouched: this reads three rows and sends mail.

const RECOVERY_NOTIFY_TEMPLATE = "merchant_recovery_notify";

export const RECOVERY_NOTIFY_FROM_NAME = "Foxhound";

export interface RecoveryNotificationContext {
  accountId: string;
  failedPaymentId: string;
}

/**
 * Why nothing was sent, or what happened when something was. THE `skipped` REASONS ARE THE POINT.
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
 * The division is now the currency's own (site-runtime ./money), so a yen amount is not shown a
 * hundred times too small.
 */
export function formatNotifyAmount(amountCents: number, currency: string): string {
  return formatMoney(amountCents, currency || "usd");
}

function recoveryNotifySubject(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
}): string {
  return `Payment recovered: ${formatNotifyAmount(data.amountCents, data.currency)} from ${data.customerLabel}`;
}

/** PLAIN STRINGS, NOT MARKUP. */
function recoveryNotifyBody(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
  declineCategory: string;
  paymentUrl: string;
}): EmailNotice {
  const amount = formatNotifyAmount(data.amountCents, data.currency);
  return {
    title: "Payment recovered.",
    body: [
      `${data.customerLabel} just paid ${amount}. ` +
        `Foxhound recovered it automatically after a ${data.declineCategory} decline.`,
    ],
    action: { label: "View payment", url: data.paymentUrl },
  };
}

/** Everything the notice job says and carries, from the loaded data. */
export function recoveryNotifyContent(
  data: { amountCents: number; currency: string; customerLabel: string; declineCategory: string },
  paymentUrl: string,
  now: Date,
): { fromName: string; subject: string; notice: EmailNotice; footerNote: string } {
  return {
    fromName: RECOVERY_NOTIFY_FROM_NAME,
    subject: recoveryNotifySubject(data),
    notice: recoveryNotifyBody({ ...data, paymentUrl }),
    footerNote: recoveryFooterNote(RECOVERY_NOTIFY_FROM_NAME, now.getUTCFullYear()),
  };
}

/** The two merchant notices differ in their toggle, template, key and words; everything else is this one path. */
interface MerchantNoticeSpec {
  label: string;
  template: string;
  idempotencyPrefix: string;
  enabled: typeof accounts.recoveryNotificationsEnabled;
  content: (
    data: NotificationData,
    paymentUrl: string,
    now: Date,
  ) => ReturnType<typeof recoveryNotifyContent>;
}

/**
 * RECIPIENT: `accounts.notification_email` ONLY. Reproduced rather than improved, because inventing
 * a fallback would email an address the merchant never nominated for this.
 */
async function loadNotificationData(
  db: Db,
  ctx: RecoveryNotificationContext,
  enabled: MerchantNoticeSpec["enabled"],
): Promise<NotificationData | { skipped: "not_found" | "no_recipient" | "disabled" }> {
  const [accountRows, paymentRows] = await Promise.all([
    db
      .select({ notificationEmail: accounts.notificationEmail, enabled })
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
    customerLabel: payment.customerName || payment.customerEmail,
    amountCents: payment.amountCents,
    currency: payment.currency,
    declineCategory: payment.declineCategory,
  };
}

/**
 * Send one merchant notice. NEVER THROWS. Returns a named outcome for the caller to log, never
 * null: a refusal names itself so it cannot be confused with a swallowed crash.
 */
export async function sendMerchantNotice(
  env: Env,
  ctx: RecoveryNotificationContext,
  spec: MerchantNoticeSpec,
): Promise<RecoveryNotificationOutcome> {
  try {
    const data = await loadNotificationData(getDb(env), ctx, spec.enabled);
    if ("skipped" in data) return { kind: "skipped", reason: data.skipped };

    const content = spec.content(
      data,
      `${appOrigin(env)}/recovery/payments/${ctx.failedPaymentId}`,
      new Date(),
    );

    const result = await processEmailJob(
      env,
      {
        accountId: ctx.accountId,
        to: data.notificationEmail,
        ...content,
        template: spec.template,
        // Platform-to-merchant mail. See EmailAudience.
        audience: "merchant",
        unsubscribeToken: "",
        physicalAddress: "",
        // Stable per payment, not per delivery: the caller only reaches this when the money write
        // applied, and that already collapses replays.
        idempotencyKey: `${spec.idempotencyPrefix}:${ctx.failedPaymentId}`,
        cronRunId: null,
      },
      null,
    );
    return { kind: "sent", result };
  } catch (err) {
    const message = errorMessage(err);
    console.error(
      `${spec.label} notification failed for account ${ctx.accountId} payment ${ctx.failedPaymentId}:`,
      message,
    );
    return { kind: "error", message };
  }
}

/** Send the notification for one just-recorded recovery. */
export function sendRecoveryNotification(
  env: Env,
  ctx: RecoveryNotificationContext,
): Promise<RecoveryNotificationOutcome> {
  return sendMerchantNotice(env, ctx, {
    label: "recovery",
    template: RECOVERY_NOTIFY_TEMPLATE,
    idempotencyPrefix: "recovery-notify",
    enabled: accounts.recoveryNotificationsEnabled,
    content: recoveryNotifyContent,
  });
}
