import { and, eq } from "drizzle-orm";

import { accounts, getDb } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { normalizeSlackWebhookUrl } from "~/lib/settings/slack-webhook";
import { openSlackWebhook } from "~/lib/notify/slack-webhook-secret.server";

// THE SLACK SENDER. NULL IS OFF. IT NEVER THROWS INTO THE CALLER, and it never blocks the email.

type SlackEventType = "email_sent" | "payment_recovered";

export interface SlackEvent {
  type: SlackEventType;
  stepType: string;
  customerEmail: string;
  customerName: string;
  amount: string;
}

export type SlackOutcome =
  | { status: "posted" }
  | { status: "disabled" }
  | { status: "no_webhook" }
  | { status: "demo" }
  | { status: "no_account" }
  | { status: "failed"; reason: string };

/** Pure and exported so a plant reads the real assembly rather than a hand-built copy. */
export function buildSlackPayload(event: SlackEvent): { text: string } {
  const emoji = event.type === "payment_recovered" ? "✅" : "📧";
  const title =
    event.type === "payment_recovered"
      ? `Payment recovered: ${event.amount}`
      : `Recovery email sent: ${event.stepType}`;
  return {
    text: `${emoji} *${title}*\nCustomer: ${event.customerName} (${event.customerEmail})\nAmount: ${event.amount}`,
  };
}

/** THE GATE, SEPARATE FROM THE POST. Splitting also makes each layer reachable on its own. */
export async function resolveSlackTarget(
  env: Env,
  accountId: string,
): Promise<{ status: "ready"; webhookUrl: string } | SlackOutcome> {
  // Demo refuses before the account read, so no demo account can ever reach an
  // outbound fetch. The existing prefix firewall, not a new one.
  if (accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) return { status: "demo" };
  try {
    const [row] = await getDb(env)
      .select({
        enabled: accounts.slackNotificationsEnabled,
        webhookUrl: accounts.slackWebhookUrl,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) return { status: "no_account" };
    if (!row.enabled) return { status: "disabled" };
    if (!row.webhookUrl) return { status: "no_webhook" };
    return { status: "ready", webhookUrl: (await openSlackWebhook(env, row.webhookUrl))! };
  } catch {
    return { status: "failed", reason: "gate_read" };
  }
}

const SLACK_TIMEOUT_MS = 5_000;

/** Post one event to a resolved webhook. */
export async function postToSlack(webhookUrl: string, event: SlackEvent): Promise<SlackOutcome> {
  return postSlackBody(webhookUrl, buildSlackPayload(event));
}

async function postSlackBody(webhookUrl: string, body: { text: string }): Promise<SlackOutcome> {
  // The host is checked again at the fetch, whatever the stored value claims,
  // and a redirect is never followed: a 3xx is a failure like any non-2xx, so
  // hooks.slack.com is the only host this request can ever reach.
  const checked = normalizeSlackWebhookUrl(webhookUrl);
  if (!checked.ok || !checked.value) return { status: "failed", reason: "host_not_allowed" };
  try {
    const res = await fetch(checked.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      // A slow host must not hold the step or queue consumer that posts.
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`slack notification rejected: ${res.status}`);
      return { status: "failed", reason: `http_${res.status}` };
    }
    return { status: "posted" };
  } catch (err) {
    // Never the error object: a thrown fetch can carry the webhook URL, which
    // is a credential.
    console.error("slack notification failed:", err instanceof Error ? err.message : "unknown");
    return { status: "failed", reason: "threw" };
  }
}

/** Gate then post. Never throws into the caller and never blocks the email. */
export async function postSlackNotification(
  env: Env,
  accountId: string,
  event: SlackEvent,
): Promise<SlackOutcome> {
  const target = await resolveSlackTarget(env, accountId);
  if (target.status !== "ready") return target;
  return postToSlack(target.webhookUrl, event);
}

export async function postSlackText(
  env: Env,
  accountId: string,
  text: string,
): Promise<SlackOutcome> {
  const target = await resolveSlackTarget(env, accountId);
  if (target.status !== "ready") return target;
  return postSlackBody(target.webhookUrl, { text });
}

/**
 * The customer fields the payload needs, read from the failed payment. Called only AFTER the gate
 * passes, so an account with Slack off pays for no query.
 */
export async function loadSlackCustomer(
  env: Env,
  accountId: string,
  failedPaymentId: string,
  nameFallback: string,
): Promise<{ customerEmail: string; customerName: string } | null> {
  const { failedPayments } = await import("~/db");
  const [row] = await getDb(env)
    .select({
      customerEmail: failedPayments.customerEmail,
      customerName: failedPayments.customerName,
    })
    .from(failedPayments)
    .where(and(eq(failedPayments.accountId, accountId), eq(failedPayments.id, failedPaymentId)))
    .limit(1);
  if (!row) return null;
  return {
    customerEmail: row.customerEmail,
    customerName: row.customerName || nameFallback,
  };
}
