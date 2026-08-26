import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type Stripe from "stripe";

import {
  customerContext,
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
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
  LIVE_FAILED_PAYMENT_STATUSES,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
  WINBACK_PRIORITY_ACTION,
  WINBACK_RECENT_RESOLVED_DAYS,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { isDisputeResolved } from "~/lib/disputes/labels";
import { recordOutcome } from "~/lib/engine/outcomes";
import { readWinbackSequenceId } from "~/lib/recovery/winback-metadata";
import {
  reactivateWinbackSequence,
  WINBACK_REACTIVATABLE_STATUSES,
} from "~/lib/recovery/winback-reactivation.server";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { executeMoneyWrite } from "~/lib/money/execute";
import { sendRecoveryNotification } from "~/lib/recovery/merchant-notification.server";
import { buildCandidateUpsert, isInsideLeadWindow } from "~/lib/cron/expiring-cards";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import {
  buildClaimOnlyBatch,
  buildDisputeIntakeBatch,
  buildDisputeResolutionBatch,
  buildIntakeBatch,
  buildRecoverBatch,
  buildInvoluntaryStopBatch,
  buildRefundStampBatch,
  buildWinbackStartBatch,
  type WebhookClaimInput,
  buildSequenceStartBatch,
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
 *  actually belongs to, not just which account.
 *
 *  LIVE ROWS ONLY (ruling 356 binding 3, DEFECT 4). This is the ONE reader that
 *  routes money: whichever row it returns decides whose ledger every failed
 *  payment, recovered payment, outcome and billing line item for this Stripe
 *  account lands on. It used to match on `stripe_user_id` alone, so a
 *  DISCONNECTED history row could answer for a Stripe account that had since
 *  been connected somewhere else, and S37's disconnect leaves exactly such rows
 *  behind. 333's rule that a disconnected connection cannot be the primary of
 *  anything, applied to the reader where getting it wrong costs money.
 *
 *  NO ORDERING IS NEEDED, and that is a fact about the schema rather than an
 *  omission: `stripe_connections_live_stripe_account_uq` makes at most one live
 *  row possible per `stripe_user_id`, so `.limit(1)` has nothing to choose
 *  between. The filter and the index are INDEPENDENT layers, deliberately, and
 *  each is proven alone (340 binding 3): the index stops the second live row
 *  being written, this stops a disconnected row answering. */
async function resolveConnection(
  env: Env,
  connectedAccountId: string,
): Promise<{ accountId: string; connectionId: string } | null> {
  const db = getDb(env);
  const rows = await db
    .select({ accountId: stripeConnections.accountId, connectionId: stripeConnections.id })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.stripeUserId, connectedAccountId),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
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
): Promise<{ id: string; status: string; declineCategory: string } | null> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: failedPayments.id,
      status: failedPayments.status,
      declineCategory: failedPayments.declineCategory,
    })
    .from(failedPayments)
    // LIVE, not just active (377(1)). A second payment_failed on the same
    // invoice has to FIND the stripe_retrying row so it can promote it; a
    // status-active-only read would miss it and create a second row for the
    // same invoice, which is the per-invoice dedupe this function exists to be.
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.stripeInvoiceId, invoiceId),
        inArray(failedPayments.status, LIVE_FAILED_PAYMENT_STATUSES),
      ),
    )
    .orderBy(desc(failedPayments.detectedAt))
    .limit(1);
  return rows[0] ?? null;
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

/** Legacy's involuntary-churn test, and since 291 also the SET to stop: every
 *  failed payment still ACTIVE for this customer. Legacy keys on 'active' alone
 *  and so does this. Unlimited by design now: legacy iterates all of them. */
async function listActiveFailedPaymentIds(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<string[]> {
  const rows = await getDb(env)
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.stripeCustomerId, stripeCustomerId),
        // LIVE, not just active. THIS IS HALT 1 OF SESSION 82 (377(1)): the
        // whole reason the row is created during Stripe's retry window instead
        // of being deferred. A subscription cancelled while the payment sits in
        // stripe_retrying is involuntary churn, and if this read cannot see the
        // row the cancellation looks voluntary and spawns a win-back campaign
        // at customers whose card just failed.
        inArray(failedPayments.status, LIVE_FAILED_PAYMENT_STATUSES),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Legacy's Intelligence win-back gate, resolved to a step-1 offset in hours.
 * Returns undefined when the gate does not apply, which leaves the schedule's
 * own default in place. Fails OPEN on any error, exactly as legacy does with its
 * try/catch around the same two lookups (entitlement, then customer context).
 */
async function resolveWinbackStep1Offset(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<number | undefined> {
  try {
    const db = getDb(env);
    // Intelligence not active on this account: legacy leaves the default.
    if (!(await isIntelligenceEntitled(db, accountId))) return undefined;
    const [ctx] = await db
      .select({ healthFactors: customerContext.healthFactors })
      .from(customerContext)
      .where(
        and(
          eq(customerContext.accountId, accountId),
          eq(customerContext.stripeCustomerId, stripeCustomerId),
        ),
      )
      .limit(1);
    const recommendation = (ctx?.healthFactors as { recommended_action?: string } | null)
      ?.recommended_action;
    return recommendation === WINBACK_PRIORITY_ACTION ? undefined : WINBACK_UNFLAGGED_STEP1_HOURS;
  } catch {
    // Fail open: the default schedule, never a silently different cadence.
    return undefined;
  }
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
async function resolveRecoveryAttribution(
  env: Env,
  failedPaymentId: string,
  recoveredAt: Date,
) {
  const db = getDb(env);
  // Deliberately unordered. Which click attributes the recovery is decided by
  // findAttributionSignals, which sorts by clickedAt desc (ruling 377(3)), so
  // this query's row order cannot reach the ledger. Ordering here as well would
  // give two guards for one rule and neither could be shown to fail alone.
  const steps = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
      clickSuspectReason: recoverySteps.clickSuspectReason,
    })
    .from(recoverySteps)
    .where(eq(recoverySteps.failedPaymentId, failedPaymentId));

  const signals = findAttributionSignals(steps, recoveredAt);
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

/**
 * The card behind a customer.updated, retrieving the payment method only when
 * the event did not already carry one (legacy's second half).
 *
 * Returns null when there is no card to read, which the caller treats as a
 * claim-only ignore rather than an error: a customer update that touches no
 * card is an ordinary event, not a failure.
 */
async function resolveExpiringCard(
  env: Env,
  connectionId: string,
  intent: { card: { expMonth: number; expYear: number; brand: string | null; last4: string | null } | null; paymentMethodId: string | null },
): Promise<{ expMonth: number; expYear: number; brand: string | null; last4: string | null } | null> {
  if (intent.card) return intent.card;
  if (!intent.paymentMethodId) return null;
  try {
    const rows = await getDb(env)
      .select({ token: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(eq(stripeConnections.id, connectionId))
      .limit(1);
    const encrypted = rows[0]?.token;
    if (!encrypted) return null;
    const stripe = getConnectedStripe(await decryptToken(env, encrypted));
    const pm = await stripe.paymentMethods.retrieve(intent.paymentMethodId);
    if (!pm.card?.exp_month || !pm.card?.exp_year) return null;
    return {
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      brand: pm.card.brand ?? null,
      last4: pm.card.last4 ?? null,
    };
  } catch (err) {
    // A Stripe failure here loses one candidate; the nightly scan finds the
    // same card again. Never fail the webhook for it.
    console.error(
      "expiring-card payment method lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Process one verified connected-account event. */
/**
 * The invoice-side reactivation attempt (344 binding 1).
 *
 * Legacy matches on the CUSTOMER and nothing else. This uses the customer only
 * to decide whether a Stripe read is worth making, and matches on the sequence
 * id carried in the subscription's metadata. A win-back sequence that exists
 * for the customer but whose id is not the one on the paid subscription is NOT
 * reactivated, which is the whole point.
 *
 * Best effort throughout: a Stripe failure here must not fail the webhook, on
 * which a real recovery and its fee may depend.
 */
export async function tryWinbackReactivationFromInvoice(
  env: Env,
  input: {
    accountId: string;
    connectionId: string;
    customerId: string | null;
    subscriptionId: string | null;
    now: Date;
  },
): Promise<void> {
  if (!input.customerId || !input.subscriptionId) return;
  const db = getDb(env);
  const candidates = await db
    .select({ id: winBackSequences.id })
    .from(winBackSequences)
    .where(
      and(
        eq(winBackSequences.accountId, input.accountId),
        eq(winBackSequences.stripeCustomerId, input.customerId),
        inArray(winBackSequences.status, WINBACK_REACTIVATABLE_STATUSES),
      ),
    )
    .limit(1);
  if (candidates.length === 0) return;

  let sequenceId: string | null = null;
  try {
    const [connection] = await db
      .select({ accessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(eq(stripeConnections.id, input.connectionId))
      .limit(1);
    if (!connection?.accessToken) return;
    const stripe = getConnectedStripe(await decryptToken(env, connection.accessToken));
    const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
    sequenceId = readWinbackSequenceId(subscription.metadata);
  } catch {
    // Never log the error object: it can carry request context.
    return;
  }
  if (!sequenceId) return;

  await reactivateWinbackSequence(env, {
    accountId: input.accountId,
    sequenceId,
    now: input.now,
  });
}

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
      // attempt. The FIRST creates the row; a later one either promotes it out
      // of stripe_retrying or is a no-op claim (377(1)).
      const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
      if (existing) {
        if (
          existing.status === FAILED_PAYMENT_STATUS_STRIPE_RETRYING &&
          intent.stripeGaveUp
        ) {
          // Stripe has stopped retrying. The sequence starts NOW, anchored on
          // this moment rather than on the original failure, which is what
          // makes "Foxhound starts when Stripe stops" true.
          const { applied } = await executeMoneyWrite(env, {
            accountId,
            // KEYED ON THE PAYMENT, NOT THE EVENT. Two different give-up events
            // for one invoice (a final payment_failed and a marked_uncollectible)
            // can both pass the status read above, because that read happens
            // outside the Durable Object. Keyed on the event they would both
            // commit and the payment would get two cadences; keyed on the
            // payment the DO's seen-set makes the second a no-op.
            idempotencyKey: `sequence-start:${existing.id}`,
            build: (db) =>
              buildSequenceStartBatch(db, {
                claim,
                failedPaymentId: existing.id,
                accountId,
                declineCategory: intent.declineCategory,
                startedAt: receivedAt,
              }),
          });
          return applied ? { status: "applied" } : { status: "duplicate" };
        }
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied
          ? {
              status: "ignored",
              reason: existing.status === FAILED_PAYMENT_STATUS_STRIPE_RETRYING
                ? "stripe_still_retrying"
                : "duplicate_attempt",
            }
          : { status: "duplicate" };
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
            stripeGaveUp: intent.stripeGaveUp,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    // invoice.marked_uncollectible: Stripe has written the invoice off, which is
    // the other way it can be finished with a payment (377(1)). Same promotion,
    // same conditional flip, so an uncollectible arriving after a final
    // payment_failed plans no second sequence.
    if (intent.kind === "stripe_gave_up") {
      const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
      if (!existing || existing.status !== FAILED_PAYMENT_STATUS_STRIPE_RETRYING) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied
          ? { status: "ignored", reason: existing ? "sequence_already_started" : "no_failed_payment" }
          : { status: "duplicate" };
      }
      const { applied } = await executeMoneyWrite(env, {
        accountId,
        // Same payment-scoped key as the payment_failed promotion above, so the
        // two events cannot each start a sequence for one invoice.
        idempotencyKey: `sequence-start:${existing.id}`,
        build: (db) =>
          buildSequenceStartBatch(db, {
            claim,
            failedPaymentId: existing.id,
            accountId,
            declineCategory: existing.declineCategory as DeclineCategory,
            startedAt: receivedAt,
          }),
      });
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    if (intent.kind === "winback_reactivate") {
      // THE REACTIVATION, PRIMARY PATH. The session carries the sequence id
      // Foxhound put on it at the resubscribe click, so the match is exact and
      // needs no Stripe read (344 binding 1).
      //
      // THE FLIP RUNS FIRST AND THROUGH THE PLAIN BATCH PATH (343 binding 3),
      // and its own status condition is the idempotency claim: a redelivery
      // flips zero rows and records no second outcome, whether it arrives
      // before or after the webhook claim below lands.
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

    if (intent.kind === "recover") {
      // THE REACTIVATION, SECOND PATH, and legacy's own event. It runs BEFORE
      // the recovery block for legacy's stated reason: that block returns early
      // when it loses its transition claim, and the two are independent.
      //
      // THE PREFILTER IS A COST GUARD, NEVER THE MATCH. Reading the
      // subscription's metadata costs a Stripe call, and the overwhelming
      // majority of paid invoices are ordinary renewals, so the cheap DB
      // question "does this customer have a live win-back at all" is asked
      // first. The MATCH is still the metadata id and only the metadata id,
      // which is exactly what stops legacy's defect: a customer with a live
      // sequence who pays a DIFFERENT subscription passes the prefilter and
      // then fails the match, as it should.
      await tryWinbackReactivationFromInvoice(env, {
        accountId,
        connectionId,
        customerId: intent.customerId,
        subscriptionId: intent.subscriptionId,
        now: receivedAt,
      });

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
        await resolveRecoveryAttribution(env, failedPaymentId, receivedAt);
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
      // THE MERCHANT NOTIFICATION, after the money write has committed and
      // changing nothing about it. `applied` is this delivery's transition
      // claim: false on a replay, because the outcomes idempotency key collides
      // and the whole batch rolls back, so a redelivered webhook sends no
      // second email. Legacy gates the same notification on the same thing, its
      // active-to-recovered update returning rows.
      //
      // It never throws (its own try/catch), for legacy's reason: the recovery
      // and its fee are already recorded and a mail failure must not unwind
      // them or fail the webhook.
      if (applied) {
        await sendRecoveryNotification(env, { accountId, failedPaymentId });
      }
      return applied ? { status: "applied" } : { status: "duplicate" };
    }

    if (intent.kind === "record_expiring_card") {
      // WRITER TWO (341 binding 4). It RECORDS and never sends: legacy's
      // handleCustomerUpdated writes the candidate row and the nightly cron
      // owns every send, so a card update cannot email a customer directly.
      //
      // The claim is the money write, as every branch here does; the candidate
      // upsert rides the same batch so a replayed event cannot double-write.
      const card = await resolveExpiringCard(env, connectionId, intent);
      if (!card || !isInsideLeadWindow(card.expMonth, card.expYear, receivedAt)) {
        const { applied } = await executeMoneyWrite(env, {
          accountId,
          idempotencyKey,
          build: (db) => buildClaimOnlyBatch(db, claim),
        });
        return applied
          ? { status: "ignored", reason: card ? "card_outside_lead_window" : "no_card" }
          : { status: "duplicate" };
      }

      const { applied } = await executeMoneyWrite(env, {
        accountId,
        idempotencyKey,
        build: (db) => [
          ...buildClaimOnlyBatch(db, claim),
          buildCandidateUpsert(
            db,
            {
              accountId,
              connectionId,
              stripeCustomerId: intent.customerId,
              customerEmail: intent.customerEmail,
              customerName: intent.customerName,
              cardBrand: card.brand,
              cardLast4: card.last4,
              expiresMonth: card.expMonth,
              expiresYear: card.expYear,
            },
            receivedAt,
          ),
        ],
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
      const involuntaryIds = await listActiveFailedPaymentIds(env, accountId, intent.customerId);
      if (involuntaryIds.length > 0) {
        // THE FLIP LANDS HERE (291), through 265's ratified transition rather
        // than legacy's unconditional per-row update. Still no win-back.
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

      // 5. THE INTELLIGENCE GATE (291), SEMANTICALLY ported from legacy (292).
      //    Legacy's provenance, quoted:
      //
      //      const { data: intelligenceProduct } = await supabase
      //        .from('account_products').select('status')
      //        .eq('account_id', accountId).eq('product', 'intelligence')
      //        .eq('status', 'active').maybeSingle()
      //      if (intelligenceProduct) {
      //        ... if (recommendation !== 'winback_priority') { step1OffsetHours = 4 }
      //      }
      //
      // THE READ TARGETS THE CAPABILITY, NOT THE STORAGE. Legacy's row IS an
      // Intelligence entitlement, and Foxhound's live entitlement is
      // isIntelligenceEntitled over account_subscriptions, which keys the SAME
      // two constants legacy keys, INTELLIGENCE_PRODUCT and
      // SUBSCRIPTION_STATUS_ACTIVE. account_products exists here but is
      // VESTIGIAL: one admin SELECT, zero writers. Reading it verbatim
      // reproduced legacy's letter and lost its meaning, because the gate stayed
      // dead even after an admin grant. 292 rules that equivalence MEASURED, so
      // this is a port and not an invented mapping. The same mapping is already
      // precedent here: dashboard/console.server.ts gates the Intelligence tile
      // on the real entitlement, for this exact reason.
      //
      // Value and direction are unchanged and stay legacy's: on an entitled
      // account a customer NOT flagged winback_priority is DELAYED from the 1h
      // default to 4h, and a flagged customer keeps the default. Legacy falls
      // open to the default on any lookup error and so does this.
      //
      // THE REMAINING BOUND, halved by this rewire (M9 carries it): the gate is
      // now REACHABLE, because grantIntelligence writes exactly the row
      // isIntelligenceEntitled reads. What it still cannot do is DISCRIMINATE:
      // nothing in Foxhound writes `winback_priority` into recommended_action,
      // and the demo seed's vocabulary does not contain the value either, so on
      // a granted account every customer takes the unflagged 4h branch today.
      // The flagged branch starts working the day a producer lands.
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
      // THE STARTED OUTCOME (343 binding 2), the pre-existing divergence this
      // session fixes. Legacy records `winback_sequence_started` at creation;
      // buildWinbackStartBatch wrote the sequence and its steps and recorded
      // nothing, so a Foxhound merchant's moat was missing a row legacy has.
      //
      // It hooks AFTER the money write and only when it applied, which is 339
      // binding 1's pattern: `applied` is this delivery's claim, false on a
      // replay because the webhook claim collides and the whole batch rolls
      // back. The outcome's own idempotency key is keyed on the SUBSCRIPTION,
      // which is what legacy keys its one-sequence-ever guard on and what
      // win_back_sequences_subscription_uq enforces here, so the two layers
      // agree on granularity.
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
