// The connected account's own intents of the connected-account webhook: account.updated, the Stripe
// account's health, and account.application.deauthorized, the grant revoked.

import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, stripeConnections } from "~/db";
import { disconnectConnectionLocal } from "~/lib/admin/merchant-cancel.server";
import { executeMoneyWrite } from "~/lib/money/execute";
import { newHealthProblems, type AccountHealth } from "~/lib/stripe/account-health";
import { sendAccountHealthNotice } from "~/lib/stripe/account-health.server";

import { buildClaimOnlyBatch } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";

/**
 * Store the account's latest health on its connection and, when the event shows a problem the
 * stored state did not have, tell the merchant once.
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
  const stale =
    !prev || (prev.healthUpdatedAt != null && prev.healthUpdatedAt >= intent.observedAt);

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

/**
 * The merchant revoked Foxhound's grant from their Stripe dashboard. An event for a Stripe account
 * Foxhound does not hold live, an audit grant included, never reaches here: process.ts claims and
 * ignores it as unknown.
 */
export async function handleConnectionDeauthorized(ctx: WebhookContext): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  await disconnectConnectionLocal(getDb(env), connectionId, receivedAt);
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, claim),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}
