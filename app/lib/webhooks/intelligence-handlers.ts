import { getDb, subscriptionChanges, type Db, type MoneyWriteBatch } from "~/db";
import { rescoreCustomer } from "~/lib/intelligence/score-inputs.server";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildClaimOnlyBatch, type WebhookClaimInput } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";

/** The claim plus one subscription_changes row per change. The rows are not
 *  money; they ride the claim's batch, as the expiring-card candidate does, so
 *  a replayed event cannot record twice. */
export function buildSubscriptionChangeBatch(
  db: Db,
  claim: WebhookClaimInput,
  accountId: string,
  intent: IntentOf<"record_subscription_change">,
  now: Date,
): MoneyWriteBatch {
  return [
    ...buildClaimOnlyBatch(db, claim),
    ...intent.changes.map((c) =>
      db.insert(subscriptionChanges).values({
        accountId,
        stripeCustomerId: intent.customerId,
        stripeSubscriptionId: intent.subscriptionId,
        stripeEventId: claim.stripeEventId,
        kind: c.kind,
        cancelAt: c.cancelAt,
        resumesAt: c.resumesAt,
        previousMrrCents: c.previousMrrCents,
        currentMrrCents: c.currentMrrCents,
        currency: c.previousMrrCents === null ? null : intent.currency,
        occurredAt: intent.occurredAt,
        createdAt: now,
      }),
    ),
  ] as MoneyWriteBatch;
}

/**
 * customer.subscription.updated with a change Intelligence tracks: record it,
 * then re-score the customer so the alerts on the next recovery tick see it
 * (rescoreCustomer). The re-score is not part of the claim: a failure there is
 * logged and the nightly batch scores the customer from the same rows, so the
 * event still claims and Stripe does not redeliver it.
 */
export async function handleRecordSubscriptionChange(
  ctx: WebhookContext,
  intent: IntentOf<"record_subscription_change">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildSubscriptionChangeBatch(db, claim, accountId, intent, receivedAt),
  });
  if (!applied) return { status: "duplicate" };
  try {
    await rescoreCustomer(getDb(env), accountId, intent.customerId, receivedAt);
  } catch (err) {
    console.error(
      `subscription change re-score failed for account ${accountId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return { status: "applied" };
}
