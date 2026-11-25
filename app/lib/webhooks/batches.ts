import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import {
  failedPayments,
  getDb,
  recoveredPayments,
  webhookEvents,
  winBackSequences,
  winBackSteps,
} from "~/db";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
} from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { isUniqueConstraintError } from "~/lib/money/serializer";
import { buildRecoveryStepInserts } from "~/lib/engine/intake";
import type { ResolvedAttribution } from "~/lib/recovery/attribution";
import { buildRecoveryBatch, type RecoveredChargeFee } from "~/lib/recovery/record-recovery";
import { planRecoverySteps } from "~/lib/recovery/schedule";
import { buildStopRecoveryBatch } from "~/lib/recovery/manual-action-batches.server";
import { planWinbackSteps, WINBACK_STATUS } from "~/lib/recovery/winback";

// The atomic DO batches for connected-account webhooks. Each side effect commits with the
// webhook_events CLAIM in ONE batch through the per-account money-write DO, keyed by account_id.

export interface WebhookClaimInput {
  stripeEventId: string;
  eventType: string;
  accountId: string | null;
  receivedAt: Date;
  payload: unknown;
}

/** The webhook_events claim insert. `processed: true` because it commits atomically with the side effects. */
export function buildWebhookClaim(db: Db, claim: WebhookClaimInput) {
  return db.insert(webhookEvents).values({
    stripeEventId: claim.stripeEventId,
    eventType: claim.eventType,
    receivedAt: claim.receivedAt,
    accountId: claim.accountId,
    processed: true,
    processingStartedAt: claim.receivedAt,
    payload: claim.payload ?? {},
  });
}

/**
 * Claim an event that resolved to nothing we own via a plain insert (not a money write): the id and
 * type are the claim, the payload (customer name, email, address) is never kept. Idempotent on the
 * unique index; returns false when it was already claimed. Anything else throws, so the route 500s
 * and Stripe retries instead of a 200 that drops the event.
 */
export async function claimEventWithoutPayload(
  env: Env,
  event: { id: string; type: string },
  receivedAt: Date,
): Promise<boolean> {
  try {
    await getDb(env).insert(webhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      receivedAt,
      accountId: null,
      processed: true,
      processingStartedAt: receivedAt,
      payload: {},
    });
    return true;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return false;
  }
}

/** The declined charge's network and card facts (migration 0049), stored on
 *  the failed payment when intake could read the charge. */
export interface ChargeFacts {
  networkAdviceCode: string | null;
  networkDeclineCode: string | null;
  cardFunding: string | null;
  cardBrand: string | null;
  cardCountry: string | null;
}

export interface IntakeBatchInput {
  claim: WebhookClaimInput;
  failedPaymentId: string;
  accountId: string;
  /**
   * The stripe_connections row this failed payment belongs to: recorded so the card-update page
   * (app/routes/utility/card-update.tsx) can resolve the CORRECT connection for an account with
   * more than one, instead of an arbitrary active one.
   */
  stripeConnectionId: string;
  stripeEventId: string;
  invoiceId: string;
  customerId: string;
  /** The invoice's subscription, when it has one. */
  subscriptionId: string | null;
  customerEmail: string;
  customerName: string | null;
  amountCents: number;
  currency: string;
  declineCode: string | null;
  declineCategory: DeclineCategory;
  /** When Foxhound first saw this payment fail. Recorded once and never moved,
   *  including when the sequence is planned later: the dashboard measures
   *  days-to-recover and failures-per-day from it, so moving it would rewrite
   *  history to say the payment failed on the day Stripe gave up. */
  detectedAt: Date;
  /**
   * Whether the sequence starts now: Stripe has stopped retrying, or the decline is hard and
   * Stripe will not retry it on this card (decline.ts isHardDecline).
   */
  startSequence: boolean;
  /** Absent or null when the charge could not be read; the columns stay null. */
  chargeFacts?: ChargeFacts | null;
}

/**
 * invoice.payment_failed: claim + insert the failed_payments row (core fields; ML enrichment via
 * extra Stripe reads is a deferred seam) and, only when Stripe has given up, the silent-first
 * recovery_steps sequence. All atomic.
 */
export function buildIntakeBatch(db: Db, input: IntakeBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  const fpInsert = db.insert(failedPayments).values({
    id: input.failedPaymentId,
    accountId: input.accountId,
    stripeConnectionId: input.stripeConnectionId,
    stripeEventId: input.stripeEventId,
    stripeInvoiceId: input.invoiceId,
    stripeCustomerId: input.customerId,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    amountCents: input.amountCents,
    currency: input.currency,
    declineCode: input.declineCode,
    declineCategory: input.declineCategory,
    status: input.startSequence
      ? FAILED_PAYMENT_STATUS_ACTIVE
      : FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
    detectedAt: input.detectedAt,
    processor: "stripe",
    processorPaymentId: input.invoiceId,
    processorCustomerId: input.customerId,
    ...input.chargeFacts,
  });
  if (!input.startSequence) return [claim, fpInsert];

  const stepInserts = buildRecoveryStepInserts(
    db,
    planRecoverySteps({
      failedPaymentId: input.failedPaymentId,
      accountId: input.accountId,
      declineCategory: input.declineCategory,
      detectedAt: input.detectedAt,
    }),
  );
  return [claim, fpInsert, ...stepInserts];
}

export interface SequenceStartBatchInput {
  claim: WebhookClaimInput;
  failedPaymentId: string;
  accountId: string;
  declineCategory: DeclineCategory;
  /**
   * THE SCHEDULE ANCHOR, which is the moment Stripe gave up, not the moment the payment first
   * failed. schedule.ts:143 adds every offset to whatever it is handed and is untouched, as are
   * RECOVERY_SCHEDULES: what moved is the value passed in.
   */
  startedAt: Date;
  /** The decline code the category came from, written only when one is known
   *  so a promotion never erases the code intake stored. */
  declineCode?: string | null;
  /** Fresh charge facts from the final attempt, written when read. */
  chargeFacts?: ChargeFacts | null;
}

/**
 * Stripe has stopped retrying: flip a `stripe_retrying` row to `active` and plan its sequence,
 * atomically with the claim. What actually stops it is the caller's idempotency key, which is
 * scoped to the PAYMENT rather than the event (see process.ts), so the money Durable Object treats
 * a second promotion of the same payment as already done.
 */
export function buildSequenceStartBatch(db: Db, input: SequenceStartBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  // The steps' category is stored with the flip, so the row and its cadence cannot disagree.
  const flip = db
    .update(failedPayments)
    .set({
      status: FAILED_PAYMENT_STATUS_ACTIVE,
      declineCategory: input.declineCategory,
      ...(input.declineCode ? { declineCode: input.declineCode } : {}),
      ...input.chargeFacts,
    })
    .where(
      and(
        eq(failedPayments.id, input.failedPaymentId),
        eq(failedPayments.accountId, input.accountId),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_STRIPE_RETRYING),
      ),
    );
  const stepInserts = buildRecoveryStepInserts(
    db,
    planRecoverySteps({
      failedPaymentId: input.failedPaymentId,
      accountId: input.accountId,
      declineCategory: input.declineCategory,
      detectedAt: input.startedAt,
    }),
  );
  return [claim, flip, ...stepInserts];
}

export interface DeclineRefreshInput {
  accountId: string;
  failedPaymentId: string;
  declineCode: string | null;
  declineCategory: DeclineCategory;
  networkAdviceCode: string | null;
  networkDeclineCode: string | null;
}

/**
 * A Foxhound retry was declined: store what that decline said, so the steps still to run read the
 * newest category and network advice (the tick loads both from the row). The decline code is
 * written only when the error carried one, as the sequence-start flip does. Only on a row still
 * `active`: a payment recovered or stopped meanwhile keeps its record, and nothing else rides this
 * batch for a zero-row match to leak into.
 */
export function buildDeclineRefreshBatch(db: Db, input: DeclineRefreshInput): MoneyWriteBatch {
  return [
    db
      .update(failedPayments)
      .set({
        declineCategory: input.declineCategory,
        ...(input.declineCode ? { declineCode: input.declineCode } : {}),
        networkAdviceCode: input.networkAdviceCode,
        networkDeclineCode: input.networkDeclineCode,
      })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      ),
  ];
}

export interface RecoverBatchInput {
  claim: WebhookClaimInput;
  accountId: string;
  failedPaymentId: string;
  amountPaidCents: number;
  currency: string;
  recoveredAt: Date;
  attribution: ResolvedAttribution;
  recoveredByStepId: string | null;
  recoveryMethod: string;
  idempotencyKey: string;
  chargeFee?: RecoveredChargeFee | null;
}

/**
 * invoice.payment_succeeded: claim + flip failed_payments active->recovered (this webhook OWNS the
 * recovered status, never a cron) + record the recovery (recovered_payments + outcomes, attributed
 * or free baseline). All atomic.
 */
export function buildRecoverBatch(db: Db, input: RecoverBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  // Conditional so a replay or concurrent event touches zero rows.
  const statusFlip = db
    .update(failedPayments)
    .set({ status: "recovered", resolvedAt: input.recoveredAt })
    .where(
      and(
        eq(failedPayments.id, input.failedPaymentId),
        eq(failedPayments.accountId, input.accountId),
        inArray(failedPayments.status, [...RECOVERABLE_FAILED_PAYMENT_STATUSES]),
      ),
    );
  const recovery = buildRecoveryBatch(db, {
    accountId: input.accountId,
    failedPaymentId: input.failedPaymentId,
    amountCents: input.amountPaidCents,
    currency: input.currency,
    recoveredAt: input.recoveredAt,
    attribution: input.attribution,
    recoveredByStepId: input.recoveredByStepId,
    recoveryMethod: input.recoveryMethod,
    idempotencyKey: input.idempotencyKey,
    chargeFee: input.chargeFee,
  });
  return [claim, statusFlip, ...recovery];
}

/**
 * charge.refunded: claim + the refund MARKER on failed_payments + the recovered_payments stamp, in
 * one atomic batch, so a claim without its marker is impossible. A full refund means no fee.
 * refunded_at is stamped only once the charge is FULLY refunded, which takes the recovery out of
 * billing altogether. Stripe sends a cumulative figure on every event and may deliver them out of
 * order, so the amount only ever grows (max) and the first full refund's time is kept.
 */
export function buildRefundStampBatch(
  db: Db,
  input: {
    claim: WebhookClaimInput;
    accountId: string;
    failedPaymentId: string;
    at: Date;
    refundedCents: number;
    full: boolean;
  },
): MoneyWriteBatch {
  const at = input.at.getTime();
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(failedPayments)
      .set({
        refundSignalCents: sql`max(coalesce(${failedPayments.refundSignalCents}, 0), ${input.refundedCents})`,
        ...(input.full
          ? { refundSignalAt: sql`coalesce(${failedPayments.refundSignalAt}, ${at})` }
          : {}),
      })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
        ),
      ),
    db
      .update(recoveredPayments)
      .set({
        refundedCents: sql`max(${recoveredPayments.refundedCents}, ${input.refundedCents})`,
        ...(input.full
          ? { refundedAt: sql`coalesce(${recoveredPayments.refundedAt}, ${at})` }
          : {}),
      })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, input.failedPaymentId),
          eq(recoveredPayments.accountId, input.accountId),
        ),
      ),
  ];
}

/** claim-only batch: a verified event we resolved to nothing actionable, still claimed so replays short-circuit. */
export function buildClaimOnlyBatch(db: Db, claim: WebhookClaimInput): MoneyWriteBatch {
  return [buildWebhookClaim(db, claim)];
}

/**
 * Foxhound already has a RATIFIED active-to-canceled transition in buildStopRecoveryBatch: the
 * status UPDATE CLAIMS on `status = 'active'`, and the steps UPDATE is conditioned on that claim
 * having landed via a correlated subquery. Reusing it is what keeps this from seating a second
 * writer against a ratified money transition, and it means a raced or redelivered stop cannot
 * double-resolve: the claim takes zero rows the second time and the steps subquery is then reading
 * a row this batch did not cancel.
 */
export interface InvoluntaryStopInput {
  claim: WebhookClaimInput;
  accountId: string;
  failedPaymentIds: string[];
  now: Date;
}

export function buildInvoluntaryStopBatch(db: Db, input: InvoluntaryStopInput): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    ...input.failedPaymentIds.flatMap((failedPaymentId) =>
      buildStopRecoveryBatch(db, {
        accountId: input.accountId,
        failedPaymentId,
        now: input.now,
      }),
    ),
  ];
}

export interface WinbackStartInput {
  claim: WebhookClaimInput;
  accountId: string;
  stripeConnectionId: string | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  customerEmail: string;
  customerName: string | null;
  planName: string | null;
  amountCents: number | null;
  currency: string | null;
  cancelReason: string | null;
  canceledAt: Date;
  /** Step-1 override from the Intelligence gate. Undefined = the default. */
  step1OffsetHours?: number;
}

/**
 * customer.subscription.deleted: claim + the win-back sequence + its steps, all atomic.
 * EXACTLY-ONCE IS STRUCTURAL, not a second mechanism: win_back_sequences carries a real UNIQUE
 * index on stripe_subscription_id (win_back_sequences_subscription_uq, schema.ts), so a
 * redelivery's insert violates it, the whole atomic batch rolls back INCLUDING the steps and the
 * claim, and executeMoneyWrite reports applied=false.
 */
export function buildWinbackStartBatch(db: Db, input: WinbackStartInput): MoneyWriteBatch {
  const sequenceId = crypto.randomUUID();
  const steps = planWinbackSteps({
    winBackSequenceId: sequenceId,
    accountId: input.accountId,
    canceledAt: input.canceledAt,
    step1OffsetHours: input.step1OffsetHours,
  });
  return [
    buildWebhookClaim(db, input.claim),
    db.insert(winBackSequences).values({
      id: sequenceId,
      accountId: input.accountId,
      stripeConnectionId: input.stripeConnectionId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      planName: input.planName,
      amountCents: input.amountCents,
      currency: input.currency,
      cancelReason: input.cancelReason,
      status: WINBACK_STATUS.ACTIVE,
      createdAt: input.canceledAt,
    }),
    ...steps.map((step) =>
      db.insert(winBackSteps).values({
        winBackSequenceId: step.winBackSequenceId,
        accountId: step.accountId,
        stepNumber: step.stepNumber,
        scheduledAt: step.scheduledAt,
      }),
    ),
  ];
}
