import { and, desc, eq } from "drizzle-orm";
import type Stripe from "stripe";

import {
  getDb,
  failedPayments,
  recoverySteps,
  stripeConnections,
  webhookEvents,
} from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { resolveAttribution } from "~/lib/recovery/attribution";
import { isRetryStep } from "~/lib/recovery/schedule";

import {
  buildClaimOnlyBatch,
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

/** Map a connected Stripe account id to our account id. */
async function resolveAccountId(
  env: Env,
  connectedAccountId: string,
): Promise<string | null> {
  const db = getDb(env);
  const rows = await db
    .select({ accountId: stripeConnections.accountId })
    .from(stripeConnections)
    .where(eq(stripeConnections.stripeUserId, connectedAccountId))
    .limit(1);
  return rows[0]?.accountId ?? null;
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

/**
 * Resolve recovery attribution from the executed steps of a failed payment: a
 * landed silent retry is the strongest signal (foxhound_retry), else a clicked
 * dunning email (email_engaged), else the free stripe_baseline. Mirrors the
 * legacy recovery_trigger logic on the SCHEMA.md attribution spine.
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

  const succeededRetry = steps.find(
    (s) => isRetryStep(s.stepType) && s.result === "retry_succeeded",
  );
  const clicked = steps.find((s) => s.clickedAt != null);
  const attribution = resolveAttribution({
    succeededRetryStepId: succeededRetry?.id ?? null,
    clickedEngagementId: clicked?.id ?? null,
  });
  const recoveredByStepId = succeededRetry?.id ?? clicked?.id ?? null;
  const recoveryMethod =
    attribution.kind === "foxhound_retry"
      ? "foxhound_retry"
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
  const accountId = await resolveAccountId(env, connectedAccountId);
  if (!accountId) {
    // Unknown account: claim via a plain insert (not a money write) so replays
    // short-circuit, then ignore. The unique index makes the claim idempotent.
    await claimUnknownAccount(env, event, receivedAt);
    return { status: "ignored", reason: "unknown_account" };
  }

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
