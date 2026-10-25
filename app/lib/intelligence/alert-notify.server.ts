import { eq } from "drizzle-orm";

import { accounts, type Db } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";
import { alertMetricLabel, isCentsMetric } from "~/lib/settings/alert-metrics";
import { normalizeSlackWebhookUrl } from "~/lib/settings/slack-webhook";

import { CRITICAL_HEALTH_SCORE_MAX, type AlertFiring } from "./alerts";
import { formatMoney } from "~/lib/money-format";

// THE ALERT EMAILS (J94, rows E21 and E22). Ported from Recova's
// lib/alert-evaluation.ts (blob 0e28ecbf, 18,968 bytes): fireEmail and
// fireSlack for a threshold alert, and the cross-product critical customers
// check with its email-then-Slack order. Recova's words, Foxhound's name.
//
// MERCHANT MAIL. Recova sends both through wrapEmailHtml(body, 'Recova') with
// no unsubscribe token, so the footer is "You're receiving this from Recova
// about a recent payment" and a "Manage email settings" link; Foxhound's
// merchant audience writes the same footer (E10), and no unsubscribe or postal
// address (RULES.md 3.16). Each goes through processEmailJob, so suppression,
// the live-send gate and the email_sends claim all apply.
//
// ON CAPSOMER'S NOTICE TEMPLATE (RULES.md 3.16; Q3). The notice has one
// heading, which Recova's mails do not: the threshold alert takes its subject
// as the heading, and the critical customers alert its own first line, so no
// word is added that Recova does not send. Recova's bold runs are plain text
// here (capsomer job_2adddfaab5dc, a bold run inside a paragraph).
//
// WRITES NOTHING (RULES.md 3.2). The firing's alert_history row and the
// cooldown reads belong to the caller, evaluateAndRecordAlerts and
// runCriticalCustomersCheck in ai-run.server.ts, which record after the send in
// Recova's order. Every send path returns a named outcome (RULES.md 3.16).
//
// SLACK HERE, NOT app/lib/notify/slack.server.ts. That sender gates on the
// account's Slack notifications toggle, as Recova's recovery-event posts do;
// Recova's alert path reads only slack_webhook_url and ignores the toggle, so
// postAlertToSlack below keeps that, with the same host and demo refusals.

export const THRESHOLD_ALERT_TEMPLATE = "alert_threshold";
export const CRITICAL_ALERT_TEMPLATE = "alert_critical_customers";

/** Recova's From for both mails is FROM_HELLO, "Recova <hello@...>", and its
 *  footer names "Recova". The platform speaks, never the merchant's sender. */
const ALERT_FROM_NAME = "Foxhound";

/**
 * THE CRITICAL CUSTOMERS ALERT IS OFF UNTIL ITS BUTTON HAS SOMEWHERE TO GO.
 *
 * Recova's mail and Slack line both send the merchant to
 * /intelligence/recommendations (row S20). Foxhound does not serve that page
 * yet (job J78, job_f8aefbc800fe, blocked on its producer), and RULES.md 2.7
 * says an email ships after its link has somewhere to go. The check below is
 * built and tested; the nightly run calls it once this is true, and a test
 * holds this equal to whether routes.ts serves the page.
 */
export const CRITICAL_CUSTOMERS_ALERT_LIVE = false;

// ---- what each says ------------------------------------------------------------

/** Recova's formatThreshold: every cents metric as US dollars, Intl's default
 *  two decimals; anything else as the bare number. */
function formatAlertValue(metric: string, value: number): string {
  if (isCentsMetric(metric)) {
    return formatMoney(value, "usd");
  }
  return String(value);
}

interface AlertMailContent {
  fromName: string;
  subject: string;
  notice: EmailNotice;
  footerNote: string;
}

/** The threshold alert (E21): Recova's fireEmail subject, sentence and button,
 *  with Foxhound's name. Pure. */
export function thresholdAlertContent(firing: AlertFiring, baseUrl: string, now: Date): AlertMailContent {
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

/** Recova's fireSlack line for a threshold alert, with Foxhound's name. Pure. */
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

/**
 * The critical customers alert (E22): Recova's subject and body, Foxhound's
 * name. Recova's bold first line is the notice's title. Two words differ from
 * Recova's, both recorded in the pull request: "a health score below 33" says
 * "of 33 or below", because Recova's own check is `health_score <= 33` and the
 * sentence was false for a score of 33; and Recova's `&mdash;` before "all
 * simultaneously" is a comma, as no em dash is ported (monthly.server.ts). Pure.
 */
export function criticalCustomersContent(count: number, baseUrl: string, now: Date): AlertMailContent {
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

/** Recova's Slack line for the critical customers alert, emoji included. Pure. */
function criticalCustomersSlackText(count: number, baseUrl: string): string {
  return (
    `\u{1F6A8} Foxhound: ${count} critical ${customerWord(count)} flagged ` +
    `(active recovery + health ≤ ${CRITICAL_HEALTH_SCORE_MAX} + open dispute). ` +
    `View recommendations: ${baseUrl}/intelligence/recommendations`
  );
}

// ---- where it goes -------------------------------------------------------------

/** The account's two channels, read as Recova reads them: notification_email
 *  only (no fallback to a login address) and slack_webhook_url. */
export interface AlertTarget {
  notificationEmail: string | null;
  slackWebhookUrl: string | null;
}

export async function loadAlertTarget(db: Db, accountId: string): Promise<AlertTarget> {
  const [row] = await db
    .select({ notificationEmail: accounts.notificationEmail, slackWebhookUrl: accounts.slackWebhookUrl })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return { notificationEmail: row?.notificationEmail ?? null, slackWebhookUrl: row?.slackWebhookUrl ?? null };
}

export type SlackPostOutcome =
  | { status: "posted" }
  | { status: "refused"; reason: "demo" | "host_not_allowed" }
  | { status: "failed"; reason: string };

/**
 * Post one line to the account's webhook, as Recova's fireSlack does: one
 * JSON body `{ text }`, `res.ok` is the answer, a throw is false. Recova reads
 * only the webhook, not the Slack notifications toggle, on both alert paths.
 * Two refusals Recova lacks: a demo account never fetches (the demo firewall,
 * RULES.md 4.12), and a stored URL off hooks.slack.com is never fetched
 * (RULES.md 4.16). Never throws, and never logs the URL, which is a credential.
 */
async function postAlertToSlack(accountId: string, webhookUrl: string, text: string): Promise<SlackPostOutcome> {
  if (accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) return { status: "refused", reason: "demo" };
  const checked = normalizeSlackWebhookUrl(webhookUrl);
  if (!checked.ok || !checked.value) return { status: "refused", reason: "host_not_allowed" };
  try {
    const res = await fetch(checked.value, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok ? { status: "posted" } : { status: "failed", reason: `http_${res.status}` };
  } catch {
    return { status: "failed", reason: "threw" };
  }
}

/** What one alert notification came to. `sent` is what alert_history records
 *  as notification_sent. */
export type AlertNotifyOutcome =
  | { channel: "email"; sent: boolean; result: EmailJobResult }
  | { channel: "slack"; sent: boolean; slack: SlackPostOutcome }
  | { channel: "none"; sent: false; reason: "no_recipient" | "no_webhook" | "channel_unknown" }
  | { channel: "error"; sent: false; message: string };

async function sendAlertMail(
  env: Env,
  input: { accountId: string; to: string; content: AlertMailContent; template: string; idempotencyKey: string },
): Promise<EmailJobResult> {
  return processEmailJob(
    env,
    {
      accountId: input.accountId,
      to: input.to,
      ...input.content,
      template: input.template,
      // Platform-to-merchant mail. See EmailAudience.
      audience: "merchant",
      unsubscribeToken: "",
      physicalAddress: "",
      idempotencyKey: input.idempotencyKey,
      cronRunId: null,
    },
    null,
  );
}

/**
 * Notify one threshold alert firing on its channel, as Recova's loop does:
 * email when the channel is email and the account has a notification address,
 * Slack when the channel is slack and it has a webhook, otherwise nothing.
 * Every alert is created with channel email today (ALERT_DEFAULT_CHANNEL; the
 * settings page offers no picker, J33), so email is the path that runs.
 * Never throws.
 */
export async function notifyThresholdAlert(
  env: Env,
  target: AlertTarget,
  firing: AlertFiring,
  firedAt: Date,
): Promise<AlertNotifyOutcome> {
  try {
    if (firing.channel === "email") {
      if (!target.notificationEmail) return { channel: "none", sent: false, reason: "no_recipient" };
      const result = await sendAlertMail(env, {
        accountId: firing.accountId,
        to: target.notificationEmail,
        content: thresholdAlertContent(firing, env.BETTER_AUTH_URL ?? "", firedAt),
        template: THRESHOLD_ALERT_TEMPLATE,
        // One logical send per firing: a firing is one alert at one instant.
        idempotencyKey: `alert:${firing.alertId}:${firedAt.getTime()}`,
      });
      return { channel: "email", sent: result.status === "sent", result };
    }
    if (firing.channel === "slack") {
      if (!target.slackWebhookUrl) return { channel: "none", sent: false, reason: "no_webhook" };
      const slack = await postAlertToSlack(firing.accountId, target.slackWebhookUrl, thresholdAlertSlackText(firing));
      return { channel: "slack", sent: slack.status === "posted", slack };
    }
    return { channel: "none", sent: false, reason: "channel_unknown" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`alert notification failed for account ${firing.accountId} alert ${firing.alertId}:`, message);
    return { channel: "error", sent: false, message };
  }
}

// ---- the critical customers notification (E22) ------------------------------

/** What the critical customers notification came to: the channel tried (or
 *  none), whether it went, and the send or post result. */
export interface CriticalNotifyOutcome {
  channel: "email" | "slack" | "none";
  notificationSent: boolean;
  detail: EmailJobResult | SlackPostOutcome | null;
}

/**
 * Notify the merchant of `count` critical customers in Recova's order: email
 * when the account has a notification address and the mail binding exists
 * (Recova's `notification_email && resend`), else Slack when it has a webhook,
 * else neither. Writes nothing (RULES.md 3.2): the caller records the firing
 * (runCriticalCustomersCheck in ai-run.server.ts). A provider refusal or a
 * refused Slack host comes back in the outcome; only a database failure
 * throws, and the caller turns that into its own named outcome, writing no
 * row, as Recova's try/catch does.
 */
export async function notifyCriticalCustomers(
  env: Env,
  db: Db,
  accountId: string,
  count: number,
  now: Date,
): Promise<CriticalNotifyOutcome> {
  const target = await loadAlertTarget(db, accountId);
  const baseUrl = env.BETTER_AUTH_URL ?? "";
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
    const slack = await postAlertToSlack(accountId, target.slackWebhookUrl, criticalCustomersSlackText(count, baseUrl));
    return { channel: "slack", notificationSent: slack.status === "posted", detail: slack };
  }
  return { channel: "none", notificationSent: false, detail: null };
}
