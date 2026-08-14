import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type Stripe from "stripe";

import {
  disputes,
  getDb,
  failedPayments,
  recoverySteps,
  stripeConnections,
  webhookEvents,
  winBackSequences,
} from "~/db";
import {
  DAY_MS,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
  WINBACK_RECENT_RESOLVED_DAYS,
} from "~/lib/constants";
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
  buildWinbackStartBatch,
  type WebhookClaimInput,
} from "./batches";
import { classifyStripeEvent } from "./events";

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

/** Find the current ACTIVE failed_payment for an invoice, if any: the per-invoice
 *  intake dedupe (Stripe emits one payment_failed per collection attempt, and
 *  only the first spawns a sequence). Deliberately narrower than
 *  findRecoverableFailedPayment: a new failure on an invoice whose earlier
 *  sequence exhausted must start a FRESH sequence, not be swallowed as a
 *  duplicate of the finished one. */
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

/** The failed_payment a successful invoice payment should be recorded against:
 *  still active, OR already flipped to failed_unrecovered by the exhausted-
 *  sequence sweep. The second case is a customer paying after the dunning
 *  cadence ran out, which is a real recovery and must not be dropped. Newest
 *  first, so when an invoice has both a finished sequence and a newer active
 *  one, the active one wins. */
async function findRecoverableFailedPayment(
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
        inArray(failedPayments.status, [...RECOVERABLE_FAILED_PAYMENT_STATUSES]),
      ),
    )
    .orderBy(desc(failedPayments.detectedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Legacy's involuntary-churn test: does this customer have ANY failed payment
 *  still ACTIVE? Legacy keys on 'active' alone and so does this. */
async function hasActiveFailedPayment(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<boolean> {
  const rows = await getDb(env)
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.stripeCustomerId, stripeCustomerId),
        eq(failedPayments.status, "active"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Legacy's already-chased test: a failed payment RESOLVED (cancelled or
 *  recovered) since the cutoff. Legacy's status pair exactly. */
async function hasRecentlyResolvedFailedPayment(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
  cutoffMs: number,
): Promise<boolean> {
  const rows = await getDb(env)
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.stripeCustomerId, stripeCustomerId),
        inArray(failedPayments.status, ["cancelled", "recovered"]),
        gte(failedPayments.resolvedAt, new Date(cutoffMs)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Legacy's replay pre-check: an existing sequence for this subscription. */
async function findWinbackSequence(
  env: Env,
  accountId: string,
  stripeSubscriptionId: string,
): Promise<string | null> {
  const rows = await getDb(env)
    .select({ id: winBackSequences.id })
    .from(winBackSequences)
    .where(
      and(
        eq(winBackSequences.accountId, accountId),
        eq(winBackSequences.stripeSubscriptionId, stripeSubscriptionId),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * The connected-account customer, for the email a win-back sequence needs.
 * BEST EFFORT BY DESIGN, and deliberately unlike resolveInvoiceIdForPaymentIntent
 * above: legacy wraps its own customers.retrieve in a try/catch and then falls
 * through to `if (!customerEmail) return`, so a Stripe failure and a customer
 * with no email reach the same place. Returning null here reproduces that. The
 * asymmetry is safe because nothing is overcharged by NOT starting a win-back,
 * which is the opposite of the refund path's exposure.
 */
async function resolveConnectedCustomer(
  env: Env,
  connectionId: string,
  stripeCustomerId: string,
): Promise<{ email: string | null; name: string | null } | null> {
  try {
    const [connection] = await getDb(env)
      .select({ accessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(eq(stripeConnections.id, connectionId))
      .limit(1);
    if (!connection?.accessToken) return null;
    const token = await decryptToken(env, connection.accessToken);
    const customer = await getConnectedStripe(token).customers.retrieve(stripeCustomerId);
    if (customer.deleted) return null;
    return { email: customer.email ?? null, name: customer.name ?? null };
  } catch {
    return null;
  }
}

/**
 * Resolve the connected-account invoice a payment_intent belongs to. Invoice
 * <-> PaymentIntent linkage is not a direct field on either object in the pinned
 * API version; search is the seam Stripe exposes for it.
 *
 * THROWS on a transient failure (no stored access token, a decrypt failure, any
 * Stripe error). Returns null ONLY for a clean miss: Stripe answered and no
 * invoice matches that payment intent. The distinction is the whole point. A
 * caller that must not lose the event lets the throw reach
 * processConnectedWebhook's catch, which 500s so Stripe redelivers with nothing
 * claimed; a best-effort caller catches it itself.
 */
async function resolveInvoiceIdForPaymentIntent(
  env: Env,
  connectionId: string,
  paymentIntentId: string,
): Promise<string | null> {
  const db = getDb(env);
  const [connection] = await db
    .select({ accessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId))
    .limit(1);
  if (!connection?.accessToken) {
    throw new Error("no stored access token for connection");
  }
  const token = await decryptToken(env, connection.accessToken);
  const stripe = getConnectedStripe(token);
  const results = await stripe.invoices.search({
    query: `payment_intent:'${paymentIntentId}'`,
    limit: 1,
  });
  return results.data[0]?.id ?? null;
}

/**
 * The failed_payments row a refunded charge belongs to, or null when the refund
 * is on a payment Foxhound never took in (a normal refund on an invoice that
 * never failed). Deliberately NOT filtered by status: by the time a refund
 * arrives the row is 'recovered', which is exactly the case that must be
 * stamped. Any transient failure throws, per
 * resolveInvoiceIdForPaymentIntent's contract.
 */
async function resolveRefundedFailedPayment(
  env: Env,
  accountId: string,
  connectionId: string,
  paymentIntentId: string,
): Promise<string | null> {
  const invoiceId = await resolveInvoiceIdForPaymentIntent(env, connectionId, paymentIntentId);
  if (!invoiceId) return null;
  const db = getDb(env);
  const rows = await db
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(and(eq(failedPayments.accountId, accountId), eq(failedPayments.stripeInvoiceId, invoiceId)))
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
    const invoiceId = await resolveInvoiceIdForPaymentIntent(env, connectionId, paymentIntentId);
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
      const failedPaymentId = await findRecoverableFailedPayment(env, accountId, intent.invoiceId);
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
            accountId,
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

    if (intent.kind === "winback_start") {
      // WIN-BACK CREATION (290), ported from legacy's handleSubscriptionDeleted.
      // Legacy's eligibility conditions in legacy's order; each returns without
      // a sequence, and each still CLAIMS the event so redelivery short-circuits.
      //
      // 1. INVOLUNTARY CHURN. Legacy: `.eq('status','active')` over this
      //    customer's failed_payments, `const isInvoluntary = ... length > 0`,
      //    and when true it cancels those payments and returns WITHOUT a
      //    win-back. A customer whose card failed did not choose to leave, so
      //    chasing them with a win-back is the wrong sequence.
      //    SCOPE, stated rather than silently dropped: the GUARD is ported here.
      //    Legacy's accompanying SIDE EFFECT, flipping those failed_payments to
      //    'cancelled' and resolving their steps, is NOT ported in this fold and
      //    is RAISED: that exact transition is 265's ratified Stop-recovery
      //    shape, which claims on `status = 'active'` and conditions the steps
      //    on the claim landing, and legacy's unconditional per-row update would
      //    either duplicate or contradict it. Re-deciding a ratified money
      //    transition is a ruling, not a build session's default.
      const involuntary = await hasActiveFailedPayment(env, accountId, intent.customerId);
      if (involuntary) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "involuntary_churn" } : { status: "duplicate" };
      }

      // 2. RECENTLY CHASED. Legacy: statuses ['cancelled','recovered'] with
      //    `resolved_at >= sevenDaysAgo`, WINBACK_RECENT_RESOLVED_DAYS = 7,
      //    "keeps Recova from chasing customers we already chased".
      const recentlyResolved = await hasRecentlyResolvedFailedPayment(
        env,
        accountId,
        intent.customerId,
        receivedAt.getTime() - WINBACK_RECENT_RESOLVED_DAYS * DAY_MS,
      );
      if (recentlyResolved) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "recently_resolved" } : { status: "duplicate" };
      }

      // 3. REPLAY GUARD. Legacy keys its own on stripe_subscription_id: "one
      //    win-back sequence per cancelled subscription, ever". This SELECT is
      //    the cheap pre-check; the real guarantee is the unique index, which
      //    makes a concurrent redelivery roll the whole batch back.
      const existing = await findWinbackSequence(env, accountId, intent.subscriptionId);
      if (existing) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "winback_exists" } : { status: "duplicate" };
      }

      // 4. THE EMAIL GATE. Legacy fetches the customer and returns on a missing
      //    address: a sequence with nobody to mail is three dead rows. The read
      //    is best-effort, so a Stripe failure ignores rather than 500s, which
      //    matches legacy catching its own retrieve and falling through to the
      //    same empty-email return.
      const customer = await resolveConnectedCustomer(env, connectionId, intent.customerId);
      if (!customer?.email) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied ? { status: "ignored", reason: "no_customer_email" } : { status: "duplicate" };
      }

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
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    // stamp_refund: ANY refund, full or partial, disqualifies the recovery from
    // billing entirely (parity ruling 29). resolveRefundedFailedPayment THROWS
    // on a transient failure instead of resolving to null, and that asymmetry is
    // deliberate: claiming a refund we could not stamp is the one direction that
    // overcharges a merchant, so an unresolvable refund leaves the event
    // unclaimed and 500s for redelivery. A clean miss (a refund on a payment we
    // never took in) is genuinely nothing to do, and claims.
    const refundedFailedPaymentId = await resolveRefundedFailedPayment(
      env,
      accountId,
      connectionId,
      intent.paymentIntentId,
    );
    if (!refundedFailedPaymentId) {
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) => buildClaimOnlyBatch(db, claim),
      });
      return applied ? { status: "ignored", reason: "refund_not_ours" } : { status: "duplicate" };
    }
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (db) =>
        buildRefundStampBatch(db, {
          claim,
          failedPaymentId: refundedFailedPaymentId,
          at: receivedAt,
        }),
    });
    return applied ? { status: "applied" } : { status: "duplicate" };
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
