// Win-back intents of the connected-account webhook: reactivation and sequence
// start. Dispatched from process.ts.

import { DAY_MS, WINBACK_RECENT_RESOLVED_DAYS } from "~/lib/constants";
import { recordOutcome } from "~/lib/engine/outcomes";
import { reactivateWinbackSequence } from "~/lib/recovery/winback-reactivation.server";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildClaimOnlyBatch, buildInvoluntaryStopBatch, buildWinbackStartBatch } from "./batches";
import {
  claimOnly,
  type IntentOf,
  type WebhookContext,
  type WebhookOutcome,
} from "./handler-context";
import { resolveConnectedCustomer } from "./connected-reads";
import {
  findWinbackSequence,
  hasRecentlyResolvedFailedPayment,
  listActiveFailedPaymentIds,
  resolveWinbackStep1Offset,
} from "./lookups";

export async function handleWinbackReactivate(
  ctx: WebhookContext,
  intent: IntentOf<"winback_reactivate">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  // THE REACTIVATION, PRIMARY PATH.
  const outcome = await reactivateWinbackSequence(env, {
    accountId,
    sequenceId: intent.sequenceId,
    now: receivedAt,
  });
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, claim),
  });
  if (!applied) return { status: "duplicate" };
  return outcome.status === "reactivated"
    ? { status: "applied" }
    : { status: "ignored", reason: `winback_${outcome.status}` };
}

export async function handleWinbackStart(
  ctx: WebhookContext,
  intent: IntentOf<"winback_start">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // INVOLUNTARY CHURN. A customer whose card failed did not choose to leave, so chasing them with a
  // win-back is the wrong sequence.
  const involuntaryIds = await listActiveFailedPaymentIds(env, accountId, intent.customerId);
  if (involuntaryIds.length > 0) {
    // Still no win-back.
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) =>
        buildInvoluntaryStopBatch(db, {
          claim,
          accountId,
          failedPaymentIds: involuntaryIds,
          now: receivedAt,
        }),
    });
    return applied ? { status: "ignored", reason: "involuntary_churn" } : { status: "duplicate" };
  }

  // 2. RECENTLY CHASED: a canceled or recovered payment resolved within
  //    WINBACK_RECENT_RESOLVED_DAYS keeps us from chasing a customer we already chased.
  const recentlyResolved = await hasRecentlyResolvedFailedPayment(
    env,
    accountId,
    intent.customerId,
    receivedAt.getTime() - WINBACK_RECENT_RESOLVED_DAYS * DAY_MS,
  );
  if (recentlyResolved) {
    return claimOnly(ctx, "recently_resolved");
  }

  // 3. REPLAY GUARD: one win-back sequence per canceled subscription, ever. This SELECT is
  //    the cheap pre-check; the real guarantee is the unique index, which
  //    makes a concurrent redelivery roll the whole batch back.
  const existing = await findWinbackSequence(env, accountId, intent.subscriptionId);
  if (existing) {
    return claimOnly(ctx, "winback_exists");
  }

  // 4. THE EMAIL GATE: a sequence with nobody to mail is three dead rows. The read is
  //    best-effort, so a Stripe failure ignores rather than 500s.
  const customer = await resolveConnectedCustomer(env, connectionId, intent.customerId);
  if (!customer?.email) {
    return claimOnly(ctx, "no_customer_email");
  }

  // 5. The flagged branch needs `winback_priority` in recommended_action; a customer without it
  // takes the unflagged 4h branch.
  const step1OffsetHours = await resolveWinbackStep1Offset(env, accountId, intent.customerId);

  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildWinbackStartBatch(db, {
        claim,
        accountId,
        stripeConnectionId: connectionId,
        stripeCustomerId: intent.customerId,
        stripeSubscriptionId: intent.subscriptionId,
        customerEmail: customer.email as string,
        customerName: customer.name ?? null,
        planName: intent.planName,
        amountCents: intent.amountCents,
        currency: intent.currency,
        cancelReason: intent.cancelReason,
        canceledAt: receivedAt,
        step1OffsetHours,
      }),
  });
  // THE STARTED OUTCOME, the pre-existing divergence this session fixes.
  if (applied) {
    await recordOutcome(env, {
      accountId,
      product: "recovery",
      eventType: "winback_sequence_started",
      outcome: "started",
      eventData: {
        amountCents: intent.amountCents,
        currency: intent.currency,
        cancelReason: intent.cancelReason,
      },
      idempotencyKey: `winback-started:${intent.subscriptionId}`,
      outcomeAt: receivedAt,
    });
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}
