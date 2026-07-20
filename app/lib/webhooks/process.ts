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
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { isDisputeResolved } from "~/lib/disputes/labels";
import { executeMoneyWrite } from "~/lib/money/execute";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import {
  buildClaimOnlyBatch,
  buildDisputeIntakeBatch,
  buildDisputeResolutionBatch,
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
// customer/charge/subscription reads), the paymentIntent->invoice resolution
// for refund stamping, and live verification of the AI evidence drafting +
// Stripe dispute submission (both wired inert-but-complete, see
// resolveDisputedRecovery and app/lib/disputes/*). Those seams call Stripe and
// are not exercised in this pass; the batch builders are unit-proven.

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

export interface DisputedRecoveryLink {
  failedPayment: {
    id: string;
    stripeCustomerId: string;
    customerEmail: string;
    customerName: string | null;
    planName: string | null;
    subscriptionStart: Date | null;
    detectedAt: Date;
  };
  steps: { stepType: string; executedAt: Date | null; openedAt: Date | null; clickedAt: Date | null }[];
}

/**
 * Resolve the recovery a disputed charge belongs to, if any: the dispute-intake
 * evidence context (TASK-foxhound-dispute-intake.md). This is the Stripe-read
 * enrichment seam (Phase 8 live): mapping a dispute's payment_intent to our
 * invoice-keyed failed_payments row needs a live connected-account read (the
 * charge/paymentIntent -> invoice resolution deferred elsewhere in this module,
 * see the stamp_refund/stamp_dispute-resolution comment below). Fails safe: a
 * missing connection token, a missing payment_intent, "not found", or any
 * Stripe/DB error all resolve to null so dispute intake still proceeds
 * (without the recovery link and its evidence facts), never blocked by this
 * seam.
 */
async function resolveDisputedRecovery(
  env: Env,
  accountId: string,
  connectionId: string,
  paymentIntentId: string | null,
): Promise<DisputedRecoveryLink | null> {
  if (!paymentIntentId) return null;
  const db = getDb(env);
  try {
    const [connection] = await db
      .select({ accessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(eq(stripeConnections.id, connectionId))
      .limit(1);
    if (!connection?.accessToken) return null;

    const token = await decryptToken(env, connection.accessToken);
    const stripe = getConnectedStripe(token);
    // Invoice<->PaymentIntent linkage is not a direct field on either object in
    // the pinned API version; search is the seam Stripe exposes for it.
    const results = await stripe.invoices.search({
      query: `payment_intent:'${paymentIntentId}'`,
      limit: 1,
    });
    const invoiceId = results.data[0]?.id ?? null;
    if (!invoiceId) return null;

    const [failedPayment] = await db
      .select({
        id: failedPayments.id,
        stripeCustomerId: failedPayments.stripeCustomerId,
        customerEmail: failedPayments.customerEmail,
        customerName: failedPayments.customerName,
        planName: failedPayments.planName,
        subscriptionStart: failedPayments.subscriptionStart,
        detectedAt: failedPayments.detectedAt,
      })
      .from(failedPayments)
      .where(and(eq(failedPayments.accountId, accountId), eq(failedPayments.stripeInvoiceId, invoiceId)))
      .orderBy(desc(failedPayments.detectedAt))
      .limit(1);
    if (!failedPayment) return null;

    const steps = await db
      .select({
        stepType: recoverySteps.stepType,
        executedAt: recoverySteps.executedAt,
        openedAt: recoverySteps.openedAt,
        clickedAt: recoverySteps.clickedAt,
      })
      .from(recoverySteps)
      .where(eq(recoverySteps.failedPaymentId, failedPayment.id));

    return { failedPayment, steps };
  } catch {
    return null;
  }
}

/** Find a dispute by its Stripe dispute id (5c resolution stamping target).
 *  submittedAt is read so resolution can decide whether Foxhound actually
 *  submitted this dispute (only a submitted win snapshots a fee). */
async function findDisputeByStripeId(
  env: Env,
  stripeDisputeId: string,
): Promise<{
  id: string;
  accountId: string;
  amountCents: number;
  currency: string;
  state: string;
  submittedAt: Date | null;
} | null> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
      state: disputes.state,
      submittedAt: disputes.submittedAt,
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

    if (intent.kind === "stamp_dispute") {
      // charge.dispute.created (dispute intake): resolve the recovery this
      // charge belongs to (if any, the Phase 8-live enrichment seam above),
      // draft evidence grounded only in what that resolution and our own
      // recovery_steps actually show, and create the dispute row, "awaiting
      // merchant review" (state pending_review), never auto-submitted.
      const linked = await resolveDisputedRecovery(env, accountId, connectionId, intent.paymentIntentId);
      const facts = buildEvidenceFacts(linked?.failedPayment ?? null, linked?.steps ?? []);
      const evidence = await draftDisputeEvidence(env, facts);
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) =>
          buildDisputeIntakeBatch(db, {
            claim,
            disputeId: crypto.randomUUID(),
            accountId,
            stripeConnectionId: connectionId,
            stripeDisputeId: intent.stripeDisputeId,
            stripeChargeId: intent.chargeId,
            stripeCustomerId: linked?.failedPayment.stripeCustomerId ?? null,
            customerEmail: linked?.failedPayment.customerEmail ?? null,
            customerName: linked?.failedPayment.customerName ?? null,
            amountCents: intent.amountCents,
            currency: intent.currency,
            reason: intent.reason,
            status: intent.status,
            evidenceDeadline: intent.evidenceDeadline,
            createdAt: intent.createdAt,
            linkedFailedPaymentId: linked?.failedPayment.id ?? null,
            evidence,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    if (intent.kind === "dispute_resolved") {
      // The dispute row normally exists by now (stamp_dispute intake runs on
      // the earlier charge.dispute.created event). A miss is defensive, not
      // expected: a safe claim-only ignore, never a throw.
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
            // A fee is snapshotted only if Foxhound actually submitted this
            // dispute (submitted_at set post-Stripe). A merchant-fought or
            // auto-resolved win carries no fee (PRICING.md rev 3).
            foxhoundSubmitted: dispute.submittedAt != null,
            resolvedAt: receivedAt,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    // stamp_refund: the paymentIntent->invoice resolution is a live Stripe seam
    // (deferred to Phase 8). Claim the event so replays short-circuit; the
    // stamp lands once the resolution seam is live.
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
