// The connected account's own intent of the connected-account webhook:
// account.updated, the Stripe account's health. Dispatched from process.ts.

import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, stripeConnections } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { newHealthProblems, type AccountHealth } from "~/lib/stripe/account-health";
import { sendAccountHealthNotice } from "~/lib/stripe/account-health.server";

import { buildClaimOnlyBatch } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";

/**
 * Store the account's latest health on its connection and, when the event shows
 * a problem the stored state did not have, tell the merchant once.
 *
 * The stored state is read before the batch (an external send cannot ride it),
 * and the write rides the claim's batch so a redelivery collapses to `applied:
 * false` and sends nothing. The write is also conditioned on the stored
 * health_updated_at being older than this event, so an older event delivered
 * late changes nothing; that case is claimed and ignored.
 */
export async function handleAccountHealth(
  ctx: WebhookContext,
  intent: IntentOf<"account_health">,
): Promise<WebhookOutcome> {
  const { env, event, accountId, connectionId, claim, idempotencyKey } = ctx;
  const [prev] = await getDb(env)
    .select({
      chargesEnabled: stripeConnections.chargesEnabled,
      payoutsEnabled: stripeConnections.payoutsEnabled,
      disabledReason: stripeConnections.disabledReason,
      pastDueCount: stripeConnections.pastDueCount,
      currentDeadline: stripeConnections.currentDeadline,
      healthUpdatedAt: stripeConnections.healthUpdatedAt,
    })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.id, connectionId), eq(stripeConnections.accountId, accountId)))
    .limit(1);
  const stale = !prev || (prev.healthUpdatedAt != null && prev.healthUpdatedAt >= intent.observedAt);

  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      stale
        ? buildClaimOnlyBatch(db, claim)
        : [
            ...buildClaimOnlyBatch(db, claim),
            db
              .update(stripeConnections)
              .set({ ...intent.health, healthUpdatedAt: intent.observedAt })
              .where(
                and(
                  eq(stripeConnections.id, connectionId),
                  eq(stripeConnections.accountId, accountId),
                  or(
                    isNull(stripeConnections.healthUpdatedAt),
                    lt(stripeConnections.healthUpdatedAt, intent.observedAt),
                  ),
                ),
              ),
          ],
  });
  if (!applied) return { status: "duplicate" };
  if (stale) return { status: "ignored", reason: "stale_account_event" };

  const before: AccountHealth = prev;
  const problems = newHealthProblems(before, intent.health);
  if (problems.length > 0) {
    await sendAccountHealthNotice(env, {
      accountId,
      connectionId,
      stripeEventId: event.id,
      problems,
      health: intent.health,
    });
  }
  return { status: "applied" };
}
