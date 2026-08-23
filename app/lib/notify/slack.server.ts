import { eq } from "drizzle-orm";

import { accounts, getDb } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";

// THE SLACK SENDER. Ported from legacy's `sendSlackNotification` in
// lib/recovery-execution.ts (blob 3a8f8768, 27,136 bytes, lines 121 to 146).
//
// LEGACY POSTS ON EXACTLY TWO EVENTS, and neither is the one a reader might
// assume:
//
//   `email_sent`        executeEmailStep, after the outcome record
//   `payment_recovered` executeRetryStep, after the outcome record, and ONLY
//                       when retryResult === 'retry_succeeded'
//
// It does NOT post on the merchant recovery notification, the sequence-complete
// notice, a win-back send, an expiring-card alert, or the weekly digest. A
// third Slack path exists in lib/alert-evaluation.ts for Intelligence alerts,
// with a different payload and a per-alert `channel` column; that is S28 and
// S35, not this module.
//
// NULL IS OFF. Legacy's gate is `merchant.slack_notifications_enabled &&
// merchant.slack_webhook_url`, a TRUTHY check on both, so an account that never
// opted in posts nothing. That makes Slack the SECOND NULL-is-OFF toggle
// alongside the digest, where 337 binding 3 records only one.
//
// IT NEVER THROWS INTO THE CALLER, and it never blocks the email. Legacy wraps
// the whole thing in try/catch and logs. Foxhound returns a DISCRIMINATED
// outcome instead of legacy's silence (339 binding 5), so a deliberate refusal
// and a swallowed failure are distinguishable, but the caller still cannot be
// broken by Slack being down.

export type SlackEventType = "email_sent" | "payment_recovered";

export interface SlackEvent {
  type: SlackEventType;
  stepType: string;
  customerEmail: string;
  customerName: string;
  /** Already formatted for display, as legacy passes it. */
  amount: string;
}

export type SlackOutcome =
  | { status: "posted" }
  | { status: "disabled" }
  | { status: "no_webhook" }
  | { status: "demo" }
  | { status: "no_account" }
  | { status: "failed"; reason: string };

/**
 * Legacy's payload, byte for byte.
 *
 * Pure and exported so a plant reads the real assembly rather than a hand-built
 * copy (337 binding 4). The emoji are legacy's own literals.
 */
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

/**
 * THE GATE, SEPARATE FROM THE POST.
 *
 * Split so a caller can refuse BEFORE loading anything the payload needs: the
 * retry site has to read the failed payment for the customer name and email,
 * and doing that on every recovered retry when Slack is off would be a query
 * for nothing. Splitting also makes each layer reachable on its own (340).
 */
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
    // Legacy's truthy gate: NULL and false are one case.
    if (!row.enabled) return { status: "disabled" };
    if (!row.webhookUrl) return { status: "no_webhook" };
    return { status: "ready", webhookUrl: row.webhookUrl };
  } catch {
    return { status: "failed", reason: "gate_read" };
  }
}

/**
 * Post one event to a resolved webhook.
 *
 * ON A NON-2xx, FOXHOUND RECORDS A REFUSAL WHERE LEGACY RECORDS NOTHING.
 * Legacy `await fetch(...)` and DISCARDS the Response, so a 404 from a revoked
 * webhook is invisible to it forever. Reading `res.ok` is class (c): the
 * merchant's own page says Slack is on, and a silently dead webhook makes that
 * a false promise. Nothing is disabled and nothing is retried, which IS
 * legacy's behaviour.
 */
export async function postToSlack(
  webhookUrl: string,
  event: SlackEvent,
): Promise<SlackOutcome> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackPayload(event)),
    });
    if (!res.ok) {
      console.error(`slack notification rejected: ${res.status}`);
      return { status: "failed", reason: `http_${res.status}` };
    }
    return { status: "posted" };
  } catch (err) {
    // Never the error object: a thrown fetch can carry the webhook URL, which
    // is a credential.
    console.error(
      "slack notification failed:",
      err instanceof Error ? err.message : "unknown",
    );
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

/**
 * The customer fields the payload needs, read from the failed payment.
 *
 * Neither executor's context carries them, and widening two context types plus
 * their loaders for a notification is the wrong shape. Called only AFTER the
 * gate passes, so an account with Slack off pays for no query.
 *
 * The fallbacks are legacy's own, and they DIFFER by site: the email path uses
 * `customer_name || 'there'` and the retry path `customer_name || 'Customer'`.
 * Ported as found rather than unified.
 */
export async function loadSlackCustomer(
  env: Env,
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
    .where(eq(failedPayments.id, failedPaymentId))
    .limit(1);
  if (!row) return null;
  return {
    customerEmail: row.customerEmail,
    customerName: row.customerName || nameFallback,
  };
}
