// Read-side lookups for the connected-account webhook processor (process.ts):
// connection resolution, failed-payment and win-back finds, and the Stripe
// reads that map a payment intent back to our rows. None of them writes money.

import { and, desc, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import {
  customerContext,
  disputes,
  getDb,
  failedPayments,
  recoverySteps,
  stripeConnections,
  winBackSequences,
} from "~/db";
import {
  LIVE_FAILED_PAYMENT_STATUSES,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
  WINBACK_PRIORITY_ACTION,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";
import { readWinbackSequenceId } from "~/lib/recovery/winback-metadata";
import {
  reactivateWinbackSequence,
  WINBACK_REACTIVATABLE_STATUSES,
} from "~/lib/recovery/winback-reactivation.server";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import { connectedStripeFor } from "./connected-reads";

/**
 * Map a connected Stripe account id to our account id AND the specific stripe_connections row it
 * resolved through: an account can have more than one active connection, so failed_payments intake
 * records which one a payment actually belongs to, not just which account. LIVE ROWS ONLY. This is
 * the ONE reader that routes money: whichever row it returns decides whose ledger every failed
 * payment, recovered payment, outcome and billing line item for this Stripe account lands on.
 */
export async function resolveConnection(
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

/**
 * True when this Stripe account has a DISCONNECTED connection here (and, as the caller already
 * found, no live one): a merchant who disconnected, or whose revoke at Stripe failed or lagged.
 */
export async function hasDisconnectedConnection(
  env: Env,
  connectedAccountId: string,
): Promise<boolean> {
  const rows = await getDb(env)
    .select({ id: stripeConnections.id })
    .from(stripeConnections)
    .where(eq(stripeConnections.stripeUserId, connectedAccountId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Find the current ACTIVE failed_payment for an invoice, if any: the per-invoice intake dedupe
 * (Stripe emits one payment_failed per collection attempt, and only the first spawns a sequence).
 * Deliberately narrower than findRecoverableFailedPayment: a new failure on an invoice whose
 * earlier sequence exhausted must start a FRESH sequence, not be swallowed as a duplicate of the
 * finished one.
 */
export async function findActiveFailedPayment(
  env: Env,
  accountId: string,
  invoiceId: string,
): Promise<{
  id: string;
  status: string;
  declineCategory: string;
  networkAdviceCode: string | null;
} | null> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: failedPayments.id,
      status: failedPayments.status,
      declineCategory: failedPayments.declineCategory,
      networkAdviceCode: failedPayments.networkAdviceCode,
    })
    .from(failedPayments)
    // LIVE, not just active. A second payment_failed on the same invoice has to FIND the
    // stripe_retrying row so it can promote it; a status-active-only read would miss it and create
    // a second row for the same invoice, which is the per-invoice dedupe this function exists to
    // be.
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

/** A query for the ids of one account's failed_payments rows matching every condition. */
function failedPaymentIds(env: Env, accountId: string, ...conditions: SQL[]) {
  return getDb(env)
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .where(and(eq(failedPayments.accountId, accountId), ...conditions));
}

/**
 * The failed_payment a successful invoice payment should be recorded against: still active, OR
 * already flipped to failed_unrecovered by the exhausted-sequence sweep. The second case is a
 * customer paying after the dunning cadence ran out, which is a real recovery and must not be
 * dropped.
 */
export async function findRecoverableFailedPayment(
  env: Env,
  accountId: string,
  invoiceId: string,
): Promise<string | null> {
  const rows = await failedPaymentIds(
    env,
    accountId,
    eq(failedPayments.stripeInvoiceId, invoiceId),
    inArray(failedPayments.status, [...RECOVERABLE_FAILED_PAYMENT_STATUSES]),
  )
    .orderBy(desc(failedPayments.detectedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function listActiveFailedPaymentIds(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<string[]> {
  const rows = await failedPaymentIds(
    env,
    accountId,
    eq(failedPayments.stripeCustomerId, stripeCustomerId),
    // LIVE, not just active.
    inArray(failedPayments.status, LIVE_FAILED_PAYMENT_STATUSES),
  );
  return rows.map((r) => r.id);
}

/**
 * Returns undefined when the gate does not apply, which leaves the schedule's own default in place.
 */
export async function resolveWinbackStep1Offset(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<number | undefined> {
  try {
    const db = getDb(env);
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

export async function hasRecentlyResolvedFailedPayment(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
  cutoffMs: number,
): Promise<boolean> {
  const rows = await failedPaymentIds(
    env,
    accountId,
    eq(failedPayments.stripeCustomerId, stripeCustomerId),
    inArray(failedPayments.status, ["cancelled", "recovered"]),
    gte(failedPayments.resolvedAt, new Date(cutoffMs)),
  ).limit(1);
  return rows.length > 0;
}

export async function findWinbackSequence(
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
 * Resolve the connected-account invoice a payment_intent belongs to. NOT invoices.search: Stripe
 * documents search as eventually consistent (new or changed data can take a minute, longer during
 * an outage, to appear), so an empty search could not tell "not ours" from "not indexed yet", and
 * the refund path would claim a refund on our own recovery and go on to bill it. THROWS on a
 * transient failure (no stored access token, a decrypt failure, any Stripe error).
 */
async function resolveInvoiceIdForPaymentIntent(
  env: Env,
  connectionId: string,
  paymentIntentId: string,
): Promise<string | null> {
  const stripe = await connectedStripeFor(env, connectionId);
  if (!stripe) throw new Error("no stored access token for connection");
  const results = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    limit: 1,
  });
  const invoice = results.data[0]?.invoice;
  if (!invoice) return null;
  return typeof invoice === "string" ? invoice : invoice.id;
}

/**
 * The failed_payments row a refunded charge belongs to, or null when the refund is on a payment
 * Foxhound never took in (a normal refund on an invoice that never failed). Deliberately NOT
 * filtered by status: by the time a refund arrives the row is 'recovered', which is exactly the
 * case that must be stamped.
 */
export async function resolveRefundedFailedPayment(
  env: Env,
  accountId: string,
  connectionId: string,
  paymentIntentId: string,
): Promise<string | null> {
  const invoiceId = await resolveInvoiceIdForPaymentIntent(env, connectionId, paymentIntentId);
  if (!invoiceId) return null;
  const rows = await failedPaymentIds(env, accountId, eq(failedPayments.stripeInvoiceId, invoiceId))
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
  steps: {
    stepType: string;
    executedAt: Date | null;
    openedAt: Date | null;
    clickedAt: Date | null;
  }[];
}

/**
 * Resolve the recovery a disputed charge belongs to, if any: the dispute-intake evidence context.
 * Two enrichment paths would be two answers to "which recovery
 * does this disputed charge belong to", and a manually imported dispute that skipped the recovery
 * link would silently stay billable on a recovery it should have excluded.
 */
export async function resolveDisputedRecovery(
  env: Env,
  accountId: string,
  connectionId: string,
  paymentIntentId: string | null,
): Promise<DisputedRecoveryLink | null> {
  if (!paymentIntentId) return null;
  const db = getDb(env);
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
    .where(
      and(eq(failedPayments.accountId, accountId), eq(failedPayments.stripeInvoiceId, invoiceId)),
    )
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
}

/** Find a dispute by its Stripe dispute id (5c resolution stamping target).
 *  submittedAt is read so resolution can decide whether Foxhound actually
 *  submitted this dispute (only a submitted win snapshots a fee). */
export async function findDisputeByStripeId(
  env: Env,
  accountId: string,
  stripeDisputeId: string,
): Promise<{
  id: string;
  amountCents: number;
  currency: string;
  state: string;
  submittedAt: Date | null;
} | null> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: disputes.id,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
      state: disputes.state,
      submittedAt: disputes.submittedAt,
    })
    .from(disputes)
    .where(and(eq(disputes.accountId, accountId), eq(disputes.stripeDisputeId, stripeDisputeId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve recovery attribution from the executed steps of a failed payment, in precedence order
 * (app/lib/recovery/attribution.ts): a landed silent retry (foxhound_retry), else a completed card
 * update through the hosted /p/:token page, else a clicked dunning email (email_engaged), else the
 * free stripe_baseline.
 */
export async function resolveRecoveryAttribution(
  env: Env,
  failedPaymentId: string,
  recoveredAt: Date,
) {
  const db = getDb(env);
  // Deliberately unordered. Ordering here as well would give two guards for one rule and neither
  // could be shown to fail alone.
  const steps = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
      executedAt: recoverySteps.executedAt,
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

/** Process one verified connected-account event. */
/**
 * The invoice-side reactivation attempt. Best effort throughout: a Stripe failure here must not
 * fail the webhook, on which a real recovery and its fee may depend.
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
    const stripe = await connectedStripeFor(env, input.connectionId);
    if (!stripe) return;
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
