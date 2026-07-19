import { and, desc, eq } from "drizzle-orm";
import type Stripe from "stripe";

import {
  disputes,
  getDb,
  failedPayments,
  recoverySteps,
  stripeConnections,
  webhookEvents,
} from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isDisputeResolved } from "~/lib/disputes/labels";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";

import {
  buildClaimOnlyBatch,
  buildDisputeResolutionBatch,
  buildDisputeStampBatch,
  buildIntakeBatch,
  buildRecoverBatch,
  buildRefundStampBatch,
  type WebhookClaimInput,
} from "./batches";
import { classifyStripeEvent } from "./events";

// Connected-account webhook processor. Resolves the account, applies per-invoice
// dedupe and attribution reads (safe before the batch; the per-account DO
// serializes the write), then commits claim + side effects as one atomic DO
// batch. Replays roll back on the webhook_events unique index -> applied=false.
//
// Deferred to Phase 8 (needs live Stripe): ML enrichment on intake (extra
// customer/charge/subscription reads), and the paymentIntent->invoice /
// charge->invoice resolution for refund/dispute stamping. Those seams call Stripe
// and are not exercised in this pass; the batch builders are unit-proven.

export type WebhookOutcome =
  | { status: "applied" }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "error"; message: string };

/** Map a connected Stripe account id to our account id AND the specific
 *  stripe_connections row it resolved through (Phase 5 review MEDIUM fix
 *  companion, 2026-07-19): an account can have more than one active
 *  connection, so failed_payments intake records which one a payment
 *  actually belongs to, not just which account. */
async function resolveConnection(
  env: Env,
  connectedAccountId: string,
): Promise<{ accountId: string; connectionId: string } | null> {
  const db = getDb(env);
  const rows = await db
    .select({ accountId: stripeConnections.accountId, connectionId: stripeConnections.id })
    .from(stripeConnections)
    .where(eq(stripeConnections.stripeUserId, connectedAccountId))
    .limit(1);
  return rows[0] ?? null;
}

/** Find the current active failed_payment for an invoice, if any (per-invoice dedupe / recover target). */
async function findActiveFailedPayment(
  env: Env,
  accountId: string,
  invoiceId: string,
): Promise<string | null> {
  const db = getDb(env);
  const rows = await db
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.stripeInvoiceId, invoiceId),
        eq(failedPayments.status, "active"),
      ),
    )
    .orderBy(desc(failedPayments.detectedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Find a dispute by its Stripe dispute id (5c resolution stamping target). */
async function findDisputeByStripeId(
  env: Env,
  stripeDisputeId: string,
): Promise<{ id: string; accountId: string; amountCents: number; currency: string; state: string } | null> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
      state: disputes.state,
    })
    .from(disputes)
    .where(eq(disputes.stripeDisputeId, stripeDisputeId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve recovery attribution from the executed steps of a failed payment,
 * in precedence order (app/lib/recovery/attribution.ts): a landed silent
 * retry (foxhound_retry), else a completed card update through the hosted
 * /p/:token page (card_update, M1 / Phase 4 review), else a clicked dunning
 * email (email_engaged), else the free stripe_baseline. Mirrors the legacy
 * recovery_trigger logic on the SCHEMA.md attribution spine.
 */
async function resolveRecoveryAttribution(env: Env, failedPaymentId: string) {
  const db = getDb(env);
  const steps = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
    })
    .from(recoverySteps)
    .where(eq(recoverySteps.failedPaymentId, failedPaymentId));

  const signals = findAttributionSignals(steps);
  const attribution = resolveAttribution(signals);
  const recoveredByStepId =
    signals.succeededRetryStepId ?? signals.cardUpdateRef ?? signals.clickedEngagementId ?? null;
  const recoveryMethod =
    attribution.kind === "foxhound_retry"
      ? "foxhound_retry"
      : attribution.kind === "card_update"
        ? "card_update"
        : attribution.kind === "email_engaged"
          ? "email"
          : "stripe_baseline";
  return { attribution, recoveredByStepId, recoveryMethod };
}

/** Process one verified connected-account event. */
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
    await claimUnknownAccount(env, event, receivedAt);
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

  try {
    if (intent.kind === "ignore") {
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) => buildClaimOnlyBatch(db, claim),
      });
      return applied ? { status: "ignored", reason: intent.reason } : { status: "duplicate" };
    }

    if (intent.kind === "intake") {
      // Per-invoice dedupe: Stripe emits one payment_failed per collection
      // attempt; only the first spawns the sequence.
      const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
      if (existing) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "duplicate_attempt" } : { status: "duplicate" };
      }
      const failedPaymentId = crypto.randomUUID();
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) =>
          buildIntakeBatch(db, {
            claim,
            failedPaymentId,
            accountId,
            stripeConnectionId: connectionId,
            stripeEventId: event.id,
            invoiceId: intent.invoiceId,
            customerId: intent.customerId,
            customerEmail: intent.customerEmail,
            customerName: intent.customerName,
            amountCents: intent.amountCents,
            currency: intent.currency,
            declineCode: intent.declineCode,
            declineCategory: intent.declineCategory,
            detectedAt: receivedAt,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    if (intent.kind === "recover") {
      const failedPaymentId = await findActiveFailedPayment(env, accountId, intent.invoiceId);
      if (!failedPaymentId) {
        // A normal renewal payment (no active failure): nothing to recover, claim only.
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "no_active_failure" } : { status: "duplicate" };
      }
      const { attribution, recoveredByStepId, recoveryMethod } =
        await resolveRecoveryAttribution(env, failedPaymentId);
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) =>
          buildRecoverBatch(db, {
            claim,
            accountId,
            failedPaymentId,
            amountPaidCents: intent.amountPaidCents,
            currency: intent.currency,
            recoveredAt: receivedAt,
            attribution,
            recoveredByStepId,
            recoveryMethod,
            idempotencyKey: failedPaymentId,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    if (intent.kind === "dispute_resolved") {
      // No dispute-intake pipeline exists yet (nothing currently inserts a
      // disputes row from charge.dispute.created), so a real dispute will not
      // be found today. That is a pre-existing gap, not a fresh assumption:
      // treat "not found" exactly like "recover" treats a missing failed
      // payment, a safe claim-only ignore, never a throw.
      const dispute = await findDisputeByStripeId(env, intent.stripeDisputeId);
      if (!dispute || dispute.accountId !== accountId) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "dispute_not_found" } : { status: "duplicate" };
      }
      if (isDisputeResolved(dispute.state)) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "already_resolved" } : { status: "duplicate" };
      }
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) =>
          buildDisputeResolutionBatch(db, {
            claim,
            stripeDisputeId: intent.stripeDisputeId,
            won: intent.won,
            amountCents: dispute.amountCents,
            currency: dispute.currency,
            resolvedAt: receivedAt,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    // stamp_refund / stamp_dispute: the paymentIntent->invoice / charge->invoice
    // resolution is a live Stripe seam (deferred to Phase 8). Claim the event so
    // replays short-circuit; the stamp lands once the resolution seam is live.
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) => buildClaimOnlyBatch(db, claim),
    });
    return applied
      ? { status: "ignored", reason: `${intent.kind}_resolution_deferred` }
      : { status: "duplicate" };
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
  } catch {
    // Unique-index violation = already claimed; idempotent no-op.
  }
}
