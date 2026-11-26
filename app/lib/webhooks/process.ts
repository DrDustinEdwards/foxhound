import type Stripe from "stripe";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildClaimOnlyBatch, claimEventWithoutPayload, type WebhookClaimInput } from "./batches";
import { classifyStripeEvent } from "./events";
import type { WebhookContext, WebhookOutcome } from "./handler-context";
import { handleDisputeResolved, handleStampDispute } from "./dispute-handlers";
import { handleAccountHealth, handleConnectionDeauthorized } from "./account-handlers";
import { handleDisputeFunds, handleDisputeUpdated, handleInquiryClosed } from "./dispute-lifecycle";
import { handleEarlyFraudWarning } from "./fraud-warning-handlers";
import {
  handleCardAutoUpdated,
  handleIntake,
  handleRecordExpiringCard,
  handleRecover,
  handleStampRefund,
  handleStripeGaveUp,
  handleInvoiceVoided,
} from "./recovery-handlers";
import { handleRenewalCardCheck } from "./renewal-check";
import { handleWinbackReactivate, handleWinbackStart } from "./winback-handlers";
import { handleRecordSubscriptionChange } from "./intelligence-handlers";
import { hasDisconnectedConnection, resolveConnection } from "./lookups";

// Connected-account webhook processor. Resolves the account, applies per-invoice dedupe and
// attribution reads (safe before the batch; the per-account DO serializes the write), then commits
// claim + side effects as one atomic DO batch. The paymentIntent->invoice resolution is NO LONGER
// deferred: refund stamping depends on it, and leaving it unwired meant refunded_at stayed null
// forever, so the billable predicate could not exclude a refunded recovery and Foxhound would
// invoice 20% of money the merchant had already given back.

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
    try {
      // A merchant who disconnected here: answer 200 but claim NOTHING. Claiming it lost a refund,
      // dispute or recovery in the gap for good.
      if (
        event.type !== "account.application.deauthorized" &&
        (await hasDisconnectedConnection(env, connectedAccountId))
      ) {
        return { status: "ignored", reason: "disconnected_account" };
      }
      // Unknown account: claim via a plain insert (not a money write) so replays
      // short-circuit, then ignore. The unique index makes the claim idempotent.
      await claimEventWithoutPayload(env, event, receivedAt);
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "webhook claim error",
      };
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
  // TEST-MODE EVENTS ARE CLAIMED AND IGNORED. Stripe sends a live Connect endpoint the connected
  // accounts' test-mode events too, and Foxhound holds a live key only, so acting on one would mail
  // a real customer about a test invoice and bill a recovery that never happened.
  const intent =
    event.livemode === false
      ? ({ kind: "ignore", reason: "test_mode" } as const)
      : classifyStripeEvent(event);
  const idempotencyKey = `webhook:${event.id}`;
  const ctx: WebhookContext = {
    env,
    event,
    receivedAt,
    accountId,
    connectionId,
    claim,
    idempotencyKey,
  };

  try {
    if (intent.kind === "ignore") {
      // An ignored event (test mode, an unhandled type) keeps its claim but not
      // its payload, so no customer address or email is held for nothing.
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) => buildClaimOnlyBatch(db, { ...claim, payload: {} }),
      });
      return applied ? { status: "ignored", reason: intent.reason } : { status: "duplicate" };
    }

    if (intent.kind === "intake") return await handleIntake(ctx, intent);
    if (intent.kind === "stripe_gave_up") return await handleStripeGaveUp(ctx, intent);
    if (intent.kind === "invoice_voided") return await handleInvoiceVoided(ctx, intent);
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
    if (intent.kind === "record_subscription_change")
      return await handleRecordSubscriptionChange(ctx, intent);
    if (intent.kind === "account_health") return await handleAccountHealth(ctx, intent);
    if (intent.kind === "connection_deauthorized") return await handleConnectionDeauthorized(ctx);
    if (intent.kind === "early_fraud_warning") return await handleEarlyFraudWarning(ctx, intent);
    if (intent.kind === "card_auto_updated") return await handleCardAutoUpdated(ctx, intent);
    return await handleStampRefund(ctx, intent);
  } catch (err) {
    // Money path: surface so the endpoint 500s and Stripe retries (the batch is
    // atomic + idempotent, so a retry is safe). Never include token material.
    return { status: "error", message: err instanceof Error ? err.message : "webhook error" };
  }
}
