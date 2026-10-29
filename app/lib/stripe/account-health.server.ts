import { and, eq } from "drizzle-orm";

import { accounts, getDb, stripeConnections } from "~/db";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { postSlackText, type SlackOutcome } from "~/lib/notify/slack.server";

import {
  ACCOUNT_HEALTH_FROM_NAME,
  accountHealthNotice,
  accountHealthSlackText,
  type AccountHealth,
  type HealthProblem,
} from "./account-health";

// THE STRIPE ACCOUNT HEALTH NOTICE: one merchant email and one Slack line when
// account.updated shows a NEW problem on a connected account (the handler in
// app/lib/webhooks/account-handlers.ts decides what is new). Legacy had no such
// notice; it follows the dispute notices' rules (app/lib/disputes/notices.server.ts):
//
// RECIPIENT: accounts.notification_email ONLY, no fallback to a login address
// (RULES.md 3.16). Sent through processEmailJob, so suppression, the per-account
// live-send gate (which also holds every demo account) and the email_sends claim
// apply. There is no per-notice toggle: like a new dispute, a Stripe account that
// cannot charge is something the merchant has to hear about.
//
// NOT HELD WHILE PAUSED. A paused account still has a Stripe account that cannot
// pay out, and pausing Foxhound is no reason to keep that from the merchant.
//
// SLACK: the same gate as the recovery posts (resolveSlackTarget), so NULL is
// OFF and a demo account never fetches.
//
// WRITES NOTHING AND NEVER THROWS. The health is already stored when this runs,
// and a mail failure must not fail the webhook.

export type AccountHealthNoticeOutcome =
  | { kind: "sent"; email: EmailJobResult | null; slack: SlackOutcome }
  | { kind: "skipped"; reason: "not_found" }
  | { kind: "error"; message: string };

export async function sendAccountHealthNotice(
  env: Env,
  ctx: {
    accountId: string;
    connectionId: string;
    stripeEventId: string;
    problems: HealthProblem[];
    health: AccountHealth;
  },
): Promise<AccountHealthNoticeOutcome> {
  try {
    const [row] = await getDb(env)
      .select({
        notificationEmail: accounts.notificationEmail,
        name: stripeConnections.name,
        stripeUserId: stripeConnections.stripeUserId,
      })
      .from(stripeConnections)
      .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
      .where(and(eq(stripeConnections.id, ctx.connectionId), eq(stripeConnections.accountId, ctx.accountId)))
      .limit(1);
    if (!row) return { kind: "skipped", reason: "not_found" };
    const label = row.name || row.stripeUserId;

    let email: EmailJobResult | null = null;
    if (row.notificationEmail) {
      const content = accountHealthNotice(ctx.problems, ctx.health, label);
      email = await processEmailJob(
        env,
        {
          accountId: ctx.accountId,
          to: row.notificationEmail,
          fromName: ACCOUNT_HEALTH_FROM_NAME,
          subject: content.subject,
          notice: content.notice,
          // Not Recova's "about a recent payment" line, which would be false here.
          footerNote: `You're receiving this from Foxhound about your connected Stripe account. \u00a9 ${new Date().getUTCFullYear()}`,
          template: "stripe_account_health",
          // Platform-to-merchant mail. See EmailAudience.
          audience: "merchant",
          unsubscribeToken: "",
          physicalAddress: "",
          // One notice per event that changed the stored state: the handler
          // only calls on an applied write, and a redelivery is not applied.
          idempotencyKey: `stripe-account-health:${ctx.connectionId}:${ctx.stripeEventId}`,
          cronRunId: null,
        },
        null,
      );
    }
    const slack = await postSlackText(env, ctx.accountId, accountHealthSlackText(ctx.problems, ctx.health, label));
    return { kind: "sent", email, slack };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`stripe account health notice failed for account ${ctx.accountId}:`, message);
    return { kind: "error", message };
  }
}
