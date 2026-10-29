import type Stripe from "stripe";
import { getDb, webhookEvents } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isUniqueConstraintError } from "~/lib/money/serializer";

import { buildClaimOnlyBatch, type WebhookClaimInput } from "./batches";
import { classifyStripeEvent } from "./events";
import type { WebhookContext, WebhookOutcome } from "./handler-context";
import { handleDisputeResolved, handleStampDispute } from "./dispute-handlers";
import { handleAccountHealth } from "./account-handlers";
import { handleDisputeFunds, handleDisputeUpdated, handleInquiryClosed } from "./dispute-lifecycle";
import { handleEarlyFraudWarning } from "./fraud-warning-handlers";
import {
  handleCardAutoUpdated,
  handleIntake,
  handleRecordExpiringCard,
  handleRecover,
  handleStampRefund,
  handleStripeGaveUp,
} from "./recovery-handlers";
import { handleRenewalCardCheck } from "./renewal-check";
import { handleWinbackReactivate, handleWinbackStart } from "./winback-handlers";
import { handleRecordSubscriptionChange } from "./intelligence-handlers";
import { resolveConnection } from "./lookups";

// Connected-account webhook processor. Resolves the account, applies per-invoice
// dedupe and attribution reads (safe before the batch; the per-account DO
// serializes the write), then commits claim + side effects as one atomic DO
// batch. Replays roll back on the webhook_events unique index -> applied=false.
//
// Deferred to Phase 8 (needs live Stripe): ML enrichment on intake (extra
// customer/charge/subscription reads), and live verification of the AI evidence
// drafting + Stripe dispute submission (both wired inert-but-complete, see
// resolveDisputedRecovery and app/lib/disputes/*). Those seams call Stripe and
// are not exercised in this pass; the batch builders are unit-proven.
//
// The paymentIntent->invoice resolution is NO LONGER deferred: refund stamping
// depends on it, and leaving it unwired meant refunded_at stayed null forever,
// so the billable predicate could not exclude a refunded recovery and Foxhound
// would invoice 20% of money the merchant had already given back.

export type { WebhookOutcome } from "./handler-context";

export async function processConnectedWebhook(
  env: Env,
  event: Stripe.Event,
  receivedAt: Date,
): Promise<WebhookOutcome> {
  const connectedAccountId = event.account ?? null;
  if (!connectedAccountId) {
    return { status: "ignored", reason: "no_connected_account" };
  }
  const resolved = await resolveConnection(env, connectedAccountId);
  if (!resolved) {
    // Unknown account: claim via a plain insert (not a money write) so replays
    // short-circuit, then ignore. The unique index makes the claim idempotent.
    try {
      await claimUnknownAccount(env, event, receivedAt);
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : "webhook claim error" };
    }
    return { status: "ignored", reason: "unknown_account" };
  }
  const { accountId, connectionId } = resolved;

  const claim: WebhookClaimInput = {
    stripeEventId: event.id,
    eventType: event.type,
    accountId,
    receivedAt,
    payload: event,
  };
  const intent = classifyStripeEvent(event);
  const idempotencyKey = `webhook:${event.id}`;
  const ctx: WebhookContext = { env, event, receivedAt, accountId, connectionId, claim, idempotencyKey };

  try {
    if (intent.kind === "ignore") {
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) => buildClaimOnlyBatch(db, claim),
      });
      return applied ? { status: "ignored", reason: intent.reason } : { status: "duplicate" };
    }

    if (intent.kind === "intake") return await handleIntake(ctx, intent);
    if (intent.kind === "stripe_gave_up") return await handleStripeGaveUp(ctx, intent);
    if (intent.kind === "winback_reactivate") return await handleWinbackReactivate(ctx, intent);
    if (intent.kind === "recover") return await handleRecover(ctx, intent);
    if (intent.kind === "record_expiring_card") return await handleRecordExpiringCard(ctx, intent);
    if (intent.kind === "renewal_card_check") return await handleRenewalCardCheck(ctx, intent);
    if (intent.kind === "stamp_dispute") return await handleStampDispute(ctx, intent);
    if (intent.kind === "dispute_resolved") return await handleDisputeResolved(ctx, intent);
    if (intent.kind === "dispute_updated") return await handleDisputeUpdated(ctx, intent);
    if (intent.kind === "dispute_funds") return await handleDisputeFunds(ctx, intent);
    if (intent.kind === "inquiry_closed") return await handleInquiryClosed(ctx, intent);
    if (intent.kind === "winback_start") return await handleWinbackStart(ctx, intent);
    if (intent.kind === "record_subscription_change") return await handleRecordSubscriptionChange(ctx, intent);
    if (intent.kind === "account_health") return await handleAccountHealth(ctx, intent);
    if (intent.kind === "early_fraud_warning") return await handleEarlyFraudWarning(ctx, intent);
    if (intent.kind === "card_auto_updated") return await handleCardAutoUpdated(ctx, intent);
    return await handleStampRefund(ctx, intent);
  } catch (err) {
    // Money path: surface so the endpoint 500s and Stripe retries (the batch is
    // atomic + idempotent, so a retry is safe). Never include token material.
    return { status: "error", message: err instanceof Error ? err.message : "webhook error" };
  }
}

/** Claim an unknown-account event via a plain insert (not a money write). Idempotent on the unique index. */
async function claimUnknownAccount(env: Env, event: Stripe.Event, receivedAt: Date): Promise<void> {
  const db = getDb(env);
  try {
    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      receivedAt,
      accountId: null,
      processed: true,
      processingStartedAt: receivedAt,
      payload: event,
    });
  } catch (err) {
    // Unique-index violation = already claimed; idempotent no-op. Anything else
    // (a transient D1 failure) throws, so the route 500s and Stripe retries.
    if (!isUniqueConstraintError(err)) throw err;
  }
}
