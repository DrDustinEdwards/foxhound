import { appOrigin } from "~/lib/app-origin";
import { eq } from "drizzle-orm";

import { accounts, type Db } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";
import { alertMetricLabel, isCentsMetric } from "~/lib/settings/alert-metrics";
import { normalizeSlackWebhookUrl } from "~/lib/settings/slack-webhook";
import { openSlackWebhook } from "~/lib/notify/slack-webhook-secret.server";

import { CRITICAL_HEALTH_SCORE_MAX } from "~/lib/constants";

import type { AlertFiring } from "./alerts";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// The alert emails: a threshold alert (fireEmail/fireSlack) and the cross-product critical customers check
// (email then Slack). Merchant mail: the notice template with the merchant audience footer, no unsubscribe or
// postal address, through processEmailJob so suppression, the live-send gate and the email_sends claim apply.
// The notice has one heading: the threshold alert uses its subject, the critical alert its first line. This
// file WRITES NOTHING: the caller (evaluateAndRecordAlerts, runCriticalCustomersCheck in ai-run.server.ts)
// records alert_history and cooldowns after the send. Slack is posted here, not via
// app/lib/notify/slack.server.ts, because the alert path reads only slack_webhook_url and ignores the
// Slack notifications toggle; same host and demo refusals.

const THRESHOLD_ALERT_TEMPLATE = "alert_threshold";
const CRITICAL_ALERT_TEMPLATE = "alert_critical_customers";

/** The platform speaks, never the merchant's sender. */
const ALERT_FROM_NAME = "Foxhound";

/** The critical customers alert links /intelligence/recommendations; a test holds this equal to whether routes.ts serves the page. */
export const CRITICAL_CUSTOMERS_ALERT_LIVE = true;

/** Every cents metric as US dollars (two decimals); anything else as the bare number. */
function formatAlertValue(metric: string, value: number): string {
  if (isCentsMetric(metric)) {
    return formatMoney(value, "usd");
  }
  return String(value);
}

export interface AlertMailContent {
  fromName: string;
  subject: string;
  notice: EmailNotice;
  footerNote: string;
}

/** The threshold alert's subject, sentence and button. Pure. */
export function thresholdAlertContent(
  firing: AlertFiring,
  baseUrl: string,
  now: Date,
): AlertMailContent {
  const label = alertMetricLabel(firing.metric);
  const subject = `Foxhound alert: ${label} ${firing.direction} threshold`;
  return {
    fromName: ALERT_FROM_NAME,
    subject,
    notice: {
      title: subject,
      body: [
        `${label} is currently ${formatAlertValue(firing.metric, firing.actualValue)}, ` +
          `which is ${firing.direction} your threshold of ${formatAlertValue(firing.metric, firing.thresholdValue)}.`,
      ],
      action: { label: "View dashboard", url: `${baseUrl}/recovery/dashboard` },
    },
    footerNote: recoveryFooterNote(ALERT_FROM_NAME, now.getUTCFullYear()),
  };
}

function thresholdAlertSlackText(firing: AlertFiring): string {
  const label = alertMetricLabel(firing.metric);
  return (
    `Foxhound alert: ${label} is ${formatAlertValue(firing.metric, firing.actualValue)}, ` +
    `which is ${firing.direction} your threshold of ${formatAlertValue(firing.metric, firing.thresholdValue)}.`
  );
}

function customerWord(count: number): string {
  return count === 1 ? "customer" : "customers";
}

/** The critical customers alert's subject and body; the bold first line is the notice's title. "of 33 or below"
 *  matches the `health_score <= 33` check, and no em dash is used (monthly.server.ts). Pure. */
export function criticalCustomersContent(
  count: number,
  baseUrl: string,
  now: Date,
): AlertMailContent {
  const word = customerWord(count);
  return {
    fromName: ALERT_FROM_NAME,
    subject: `Foxhound: ${count} critical ${word} need attention`,
    notice: {
      title: `${count} critical ${word} need immediate attention.`,
      body: [
        `These customers have an active recovery sequence, a health score of ${CRITICAL_HEALTH_SCORE_MAX} or below ` +
          "(high churn risk), and an open dispute, all simultaneously.",
      ],
      action: { label: "View recommendations", url: `${baseUrl}/intelligence/recommendations` },
    },
    footerNote: recoveryFooterNote(ALERT_FROM_NAME, now.getUTCFullYear()),
  };
}

function criticalCustomersSlackText(count: number, baseUrl: string): string {
  return (
    `\u{1F6A8} Foxhound: ${count} critical ${customerWord(count)} flagged ` +
    `(active recovery + health ≤ ${CRITICAL_HEALTH_SCORE_MAX} + open dispute). ` +
    `View recommendations: ${baseUrl}/intelligence/recommendations`
  );
}

/** The account's two channels: notification_email only (no fallback to a login address) and slack_webhook_url. */
export interface AlertTarget {
  notificationEmail: string | null;
  slackWebhookUrl: string | null;
}

export async function loadAlertTarget(env: Env, db: Db, accountId: string): Promise<AlertTarget> {
  const [row] = await db
    .select({
      notificationEmail: accounts.notificationEmail,
      slackWebhookUrl: accounts.slackWebhookUrl,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return {
    notificationEmail: row?.notificationEmail ?? null,
    slackWebhookUrl: await openSlackWebhook(env, row?.slackWebhookUrl ?? null),
  };
}

type SlackPostOutcome =
  | { status: "posted" }
  | { status: "refused"; reason: "demo" | "host_not_allowed" }
  | { status: "failed"; reason: string };

/** Post one `{ text }` line to the account's webhook; `res.ok` is the answer, a throw is false. A demo account
 *  never fetches and a stored URL off hooks.slack.com is never fetched. Never throws, never logs the URL (a credential). */
async function postAlertToSlack(
  accountId: string,
  webhookUrl: string,
  text: string,
): Promise<SlackPostOutcome> {
  if (accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) return { status: "refused", reason: "demo" };
  const checked = normalizeSlackWebhookUrl(webhookUrl);
  if (!checked.ok || !checked.value) return { status: "refused", reason: "host_not_allowed" };
  try {
    // A redirect is never followed: a 3xx is not ok, so hooks.slack.com is the only host reachable.
    const res = await fetch(checked.value, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      redirect: "manual",
    });
    return res.ok ? { status: "posted" } : { status: "failed", reason: `http_${res.status}` };
  } catch {
    return { status: "failed", reason: "threw" };
  }
}

/** What one alert notification came to; `sent` is what alert_history records as notification_sent. */
export type AlertNotifyOutcome =
  | { channel: "email"; sent: boolean; result: EmailJobResult }
  | { channel: "slack"; sent: boolean; slack: SlackPostOutcome }
  | { channel: "none"; sent: false; reason: "no_recipient" | "no_webhook" | "channel_unknown" }
  | { channel: "error"; sent: false; message: string };

async function sendAlertMail(
  env: Env,
  input: {
    accountId: string;
    to: string;
    content: AlertMailContent;
    template: string;
    idempotencyKey: string;
  },
): Promise<EmailJobResult> {
  return processEmailJob(
    env,
    {
      accountId: input.accountId,
      to: input.to,
      ...input.content,
      template: input.template,
      audience: "merchant",
      unsubscribeToken: "",
      physicalAddress: "",
      idempotencyKey: input.idempotencyKey,
      cronRunId: null,
    },
    null,
  );
}

/** Notify one threshold alert firing on its channel: email when the channel is email and the account has a
 *  notification address, Slack when slack and it has a webhook, else nothing. Alerts default to email
 *  (ALERT_DEFAULT_CHANNEL), so email is the path that runs. Never throws. */
export async function notifyThresholdAlert(
  env: Env,
  target: AlertTarget,
  firing: AlertFiring,
  firedAt: Date,
): Promise<AlertNotifyOutcome> {
  try {
    if (firing.channel === "email") {
      if (!target.notificationEmail)
        return { channel: "none", sent: false, reason: "no_recipient" };
      const result = await sendAlertMail(env, {
        accountId: firing.accountId,
        to: target.notificationEmail,
        content: thresholdAlertContent(firing, appOrigin(env), firedAt),
        template: THRESHOLD_ALERT_TEMPLATE,
        idempotencyKey: `alert:${firing.alertId}:${firedAt.getTime()}`,
      });
      return { channel: "email", sent: result.status === "sent", result };
    }
    if (firing.channel === "slack") {
      if (!target.slackWebhookUrl) return { channel: "none", sent: false, reason: "no_webhook" };
      const slack = await postAlertToSlack(
        firing.accountId,
        target.slackWebhookUrl,
        thresholdAlertSlackText(firing),
      );
      return { channel: "slack", sent: slack.status === "posted", slack };
    }
    return { channel: "none", sent: false, reason: "channel_unknown" };
  } catch (err) {
    const message = errorMessage(err);
    console.error(
      `alert notification failed for account ${firing.accountId} alert ${firing.alertId}:`,
      message,
    );
    return { channel: "error", sent: false, message };
  }
}

export interface CriticalNotifyOutcome {
  channel: "email" | "slack" | "none";
  notificationSent: boolean;
  detail: EmailJobResult | SlackPostOutcome | null;
}

/** Notify of `count` critical customers: email when the account has a notification address and the mail binding
 *  exists, else Slack when it has a webhook, else neither. Writes nothing. A provider or Slack-host refusal comes
 *  back in the outcome; only a database failure throws, and the caller writes no row. */
export async function notifyCriticalCustomers(
  env: Env,
  db: Db,
  accountId: string,
  count: number,
  now: Date,
): Promise<CriticalNotifyOutcome> {
  const target = await loadAlertTarget(env, db, accountId);
  const baseUrl = appOrigin(env);
  if (target.notificationEmail && env.EMAIL) {
    const result = await sendAlertMail(env, {
      accountId,
      to: target.notificationEmail,
      content: criticalCustomersContent(count, baseUrl, now),
      template: CRITICAL_ALERT_TEMPLATE,
      idempotencyKey: `critical-customers:${accountId}:${now.getTime()}`,
    });
    return { channel: "email", notificationSent: result.status === "sent", detail: result };
  }
  if (target.slackWebhookUrl) {
    const slack = await postAlertToSlack(
      accountId,
      target.slackWebhookUrl,
      criticalCustomersSlackText(count, baseUrl),
    );
    return { channel: "slack", notificationSent: slack.status === "posted", detail: slack };
  }
  return { channel: "none", notificationSent: false, detail: null };
}
