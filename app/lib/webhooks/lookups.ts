// Read-side lookups for the connected-account webhook processor (process.ts):
// connection resolution, failed-payment and win-back finds, and the Stripe
// reads that map a payment intent back to our rows. None of them writes money.

import type Stripe from "stripe";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
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
import { pickDeclineCode } from "~/lib/recovery/decline";
import type { RecoveredChargeFee } from "~/lib/recovery/record-recovery";
import { getConnectedStripe } from "~/lib/stripe/client";
import { latestInvoiceCharge } from "~/lib/stripe/invoice-charge";
import { decryptToken } from "~/lib/stripe/encryption";

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

/** Find the current ACTIVE failed_payment for an invoice, if any: the per-invoice
 *  intake dedupe (Stripe emits one payment_failed per collection attempt, and
 *  only the first spawns a sequence). Deliberately narrower than
 *  findRecoverableFailedPayment: a new failure on an invoice whose earlier
 *  sequence exhausted must start a FRESH sequence, not be swallowed as a
 *  duplicate of the finished one. */
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
export async function findRecoverableFailedPayment(
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
export async function listActiveFailedPaymentIds(
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
        // of being deferred. A subscription canceled while the payment sits in
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
 * try/catch around the same lookup (customer context; legacy's entitlement check
 * went with Intelligence's price, Dustin 2026-10-29).
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

/** Legacy's already-chased test: a failed payment RESOLVED (canceled or
 *  recovered) since the cutoff. Legacy's status pair exactly. */
export async function hasRecentlyResolvedFailedPayment(
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
 * The connected-account customer, for the email a win-back sequence needs.
 * BEST EFFORT BY DESIGN, and deliberately unlike resolveInvoiceIdForPaymentIntent
 * above: legacy wraps its own customers.retrieve in a try/catch and then falls
 * through to `if (!customerEmail) return`, so a Stripe failure and a customer
 * with no email reach the same place. Returning null here reproduces that. The
 * asymmetry is safe because nothing is overcharged by NOT starting a win-back,
 * which is the opposite of the refund path's exposure.
 */
export async function resolveConnectedCustomer(
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
 * API version; the InvoicePayments list, filtered by payment intent, is the seam.
 * NOT invoices.search: Stripe documents search as eventually consistent (new or
 * changed data can take a minute, longer during an outage, to appear), so an
 * empty search could not tell "not ours" from "not indexed yet", and the refund
 * path would claim a refund on our own recovery and go on to bill it. A list
 * read is not indexed, so an empty page is a real answer.
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
  const results = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    limit: 1,
  });
  const invoice = results.data[0]?.invoice;
  if (!invoice) return null;
  return typeof invoice === "string" ? invoice : invoice.id;
}

/**
 * The failed_payments row a refunded charge belongs to, or null when the refund
 * is on a payment Foxhound never took in (a normal refund on an invoice that
 * never failed). Deliberately NOT filtered by status: by the time a refund
 * arrives the row is 'recovered', which is exactly the case that must be
 * stamped. Any transient failure throws, per
 * resolveInvoiceIdForPaymentIntent's contract.
 */
export async function resolveRefundedFailedPayment(
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
 *
 * EXPORTED under ruling 400 for the manual dispute import
 * (app/lib/disputes/manual-import.server.ts), which enriches a hand-imported
 * dispute through this same seam. Two enrichment paths would be two answers to
 * "which recovery does this disputed charge belong to", and a manually imported
 * dispute that skipped the recovery link would silently stay billable on a
 * recovery it should have excluded.
 */
export async function resolveDisputedRecovery(
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
export async function findDisputeByStripeId(
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
export async function resolveRecoveryAttribution(
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
export async function resolveExpiringCard(
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

/** The connected account's Stripe client, or null when the connection has no
 *  token. Decrypt and lookup errors propagate to the caller's catch. */
async function connectedStripeFor(env: Env, connectionId: string) {
  const [connection] = await getDb(env)
    .select({ accessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(eq(stripeConnections.id, connectionId))
    .limit(1);
  if (!connection?.accessToken) return null;
  return getConnectedStripe(await decryptToken(env, connection.accessToken));
}

/** What the declined charge says about a failure, beyond what the invoice event
 *  carries. Every field is nullable: Stripe fills them per network and card. */
export interface DeclineFacts {
  declineCode: string | null;
  networkAdviceCode: string | null;
  networkDeclineCode: string | null;
  cardFunding: string | null;
  cardBrand: string | null;
  cardCountry: string | null;
}

/** What intake reads from Stripe about a failure: the declined charge's facts
 *  and the invoice's status now. Either is null when it could not be read. */
export interface FailureFacts {
  decline: DeclineFacts | null;
  /** The invoice's current status ("open", "paid", "void" and so on). A late
   *  or redelivered payment_failed can arrive after the invoice was paid or
   *  voided, and the event carries the invoice as it was then. */
  invoiceStatus: string | null;
}

/**
 * The decline facts of an invoice's latest charge, and the invoice's current
 * status, for intake. The invoice event cannot give the decline: on the pinned
 * API version it has no `charge`, and last_finalization_error covers
 * finalization only, so a real payment failure used to arrive with no decline
 * code and be classified "unknown".
 *
 * The decline code is the payment intent's last_payment_error.decline_code,
 * then the issuer's reason on the charge outcome, then the charge's
 * failure_code, the generic "card_declined" yielding to any specific code.
 *
 * BEST EFFORT. Each half is null on any failure (no token, a decrypt failure,
 * any Stripe error) and logs it: intake must never be blocked by a read, and
 * the caller falls back to what the event carried.
 */
export async function resolveFailureFacts(
  env: Env,
  connectionId: string,
  invoiceId: string,
): Promise<FailureFacts> {
  let stripe: Stripe | null;
  try {
    stripe = await connectedStripeFor(env, connectionId);
  } catch (err) {
    console.error("intake connection read failed:", err instanceof Error ? err.message : "unknown error");
    return { decline: null, invoiceStatus: null };
  }
  if (!stripe) return { decline: null, invoiceStatus: null };
  let invoiceStatus: string | null = null;
  try {
    invoiceStatus = (await stripe.invoices.retrieve(invoiceId)).status ?? null;
  } catch (err) {
    console.error("intake invoice read failed:", err instanceof Error ? err.message : "unknown error");
  }
  return { decline: await readDeclineFacts(stripe, invoiceId), invoiceStatus };
}

async function readDeclineFacts(stripe: Stripe, invoiceId: string): Promise<DeclineFacts | null> {
  try {
    const latest = await latestInvoiceCharge(stripe, invoiceId);
    if (!latest) return null;
    const { paymentIntent, charge } = latest;
    const outcome = charge.outcome;
    const card = charge.payment_method_details?.card;
    return {
      declineCode: pickDeclineCode([
        paymentIntent.last_payment_error?.decline_code,
        outcome?.type === "issuer_declined" ? outcome.reason : null,
        charge.failure_code,
      ]),
      networkAdviceCode: outcome?.network_advice_code ?? null,
      networkDeclineCode: outcome?.network_decline_code ?? null,
      cardFunding: card?.funding ?? null,
      cardBrand: card?.brand ?? null,
      cardCountry: card?.country ?? null,
    };
  } catch (err) {
    console.error("intake decline facts read failed:", err instanceof Error ? err.message : "unknown error");
    return null;
  }
}

/**
 * The fee and net of a paid invoice's charge, for the recovery record. One
 * invoice payments list and one payment intent read, the charge's balance
 * transaction expanded in the same call.
 *
 * BEST EFFORT, like resolveFailureFacts. Null on any failure, and on a charge
 * whose balance transaction Stripe has not created yet: the recovery and its
 * billing never wait on this read, and the columns stay null for a later
 * backfill. The payout is not read: a balance transaction does not name its
 * payout, and finding it would mean listing payouts.
 */
export async function resolveRecoveredChargeFee(
  env: Env,
  connectionId: string,
  invoiceId: string,
): Promise<RecoveredChargeFee | null> {
  try {
    const stripe = await connectedStripeFor(env, connectionId);
    if (!stripe) return null;
    const latest = await latestInvoiceCharge(stripe, invoiceId, { balanceTransaction: true });
    const bt = latest?.charge.balance_transaction;
    if (!bt || typeof bt === "string") return null;
    return {
      stripeBalanceTransactionId: bt.id,
      stripeFeeCents: bt.fee,
      netAmountCents: bt.net,
      netCurrency: bt.currency,
    };
  } catch (err) {
    console.error("recovered charge fee read failed:", err instanceof Error ? err.message : "unknown error");
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
