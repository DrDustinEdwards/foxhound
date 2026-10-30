import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import {
  disputeEvidence,
  disputes,
  failedPayments,
  recoveredPayments,
  webhookEvents,
  winBackSequences,
  winBackSteps,
} from "~/db";
import type { ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import { disputeFeeCents, feeForCurrency } from "~/lib/billing/fees";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
} from "~/lib/constants";
import type { DeclineCategory, DisputeState } from "~/lib/constants";
import type { EvidenceField } from "~/lib/disputes/evidence";
import type { DisputeContextColumns } from "~/lib/disputes/triage";
import { buildRecoveryStepInserts } from "~/lib/engine/intake";
import type { ResolvedAttribution } from "~/lib/recovery/attribution";
import { buildRecoveryBatch, type RecoveredChargeFee } from "~/lib/recovery/record-recovery";
import { planRecoverySteps } from "~/lib/recovery/schedule";
import { buildStopRecoveryBatch } from "~/lib/recovery/manual-action-batches.server";
import { planWinbackSteps, WINBACK_STATUS } from "~/lib/recovery/winback";

// The atomic DO batches for connected-account webhook processing. Every webhook
// side effect is committed together with the webhook_events CLAIM in ONE batch
// through the per-account money-write DO. The webhook_events unique index on
// stripe_event_id is the exactly-once key: a replay makes the claim insert fail
// the unique constraint, the whole batch rolls back, and executeMoneyWrite
// reports applied=false (idempotent no-op). Claim-with-side-effects is stronger
// than a separate claim step: there is no "claimed but not processed" gap.
//
// DEVIATION (flagged for Dustin): ARCHITECTURE.md lists a distinct webhook-claim
// DO keyed by event id. We instead fold the claim into the per-account money-write
// DO batch keyed by account_id. The exactly-once guarantee is preserved (unique
// index) and atomicity is stronger. Reconcile the canon DO count when convenient.

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
  /** The stripe_connections row this failed payment belongs to (Phase 5
   *  review MEDIUM fix companion, 2026-07-19): recorded so the card-update
   *  page (app/routes/utility/card-update.tsx) can resolve the CORRECT
   *  connection for an account with more than one, instead of an arbitrary
   *  active one. */
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
   * Whether the sequence starts now: Stripe has stopped retrying (ruling
   * 377(1)), or the decline is hard and Stripe will not retry it on this card
   * (decline.ts isHardDecline). False parks the row in `stripe_retrying` with
   * NO steps planned; true is a live sequence from the first event.
   */
  startSequence: boolean;
  /** Absent or null when the charge could not be read; the columns stay null. */
  chargeFacts?: ChargeFacts | null;
}

/**
 * invoice.payment_failed: claim + insert the failed_payments row (core fields;
 * ML enrichment via extra Stripe reads is a deferred seam) +, ONLY when Stripe
 * has given up, the silent-first recovery_steps sequence. All atomic.
 *
 * The split is ruling 377(1). Foxhound used to plan the sequence on the first
 * failure, so its 4-hour retry and day-1 email ran while Stripe's own Smart
 * Retries were still scheduled, and a click on a Foxhound email during Stripe's
 * window made Stripe's recovery billable. The row is still created immediately,
 * because the involuntary-churn guard keys on it existing.
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
   * THE SCHEDULE ANCHOR, which is the moment Stripe gave up, not the moment the
   * payment first failed. schedule.ts:143 adds every offset to whatever it is
   * handed and is untouched, as are RECOVERY_SCHEDULES: what moved is the value
   * passed in.
   *
   * The row's own `detected_at` stays where it was, and the two are deliberately
   * different numbers. 377(1) records the cost of the split as "day 30 becomes
   * roughly day 58", which is counted from the ORIGINAL failure; that arithmetic
   * only works if detected_at still marks it. Moving the column instead would
   * make every sequence look like it finished on day 30 and would move the
   * payment's failure date on the dashboard.
   */
  startedAt: Date;
  /** The decline code the category came from, written only when one is known
   *  so a promotion never erases the code intake stored. */
  declineCode?: string | null;
  /** Fresh charge facts from the final attempt, written when read. */
  chargeFacts?: ChargeFacts | null;
}

/**
 * Stripe has stopped retrying: flip a `stripe_retrying` row to `active` and plan
 * its sequence, atomically with the claim.
 *
 * THE UPDATE IS CONDITIONAL ON THE ROW STILL BEING `stripe_retrying`, so a
 * second promotion flips nothing. That alone is NOT what stops a second
 * cadence, and the first version of this comment claimed it was. A plant that
 * ran this batch directly measured the truth: a WHERE matching zero rows does
 * not abort a batch, so the step inserts landed anyway and the payment got
 * sixteen steps. What actually stops it is the caller's idempotency key, which
 * is scoped to the PAYMENT rather than the event (see process.ts), so the money
 * Durable Object treats a second promotion of the same payment as already done.
 * Recorded this way because the wrong version was believable.
 */
export function buildSequenceStartBatch(db: Db, input: SequenceStartBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  // The category the steps are planned from is stored with the flip, so the
  // row and its cadence cannot disagree.
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
 * A Foxhound retry was declined: store what that decline said, so the steps
 * still to run read the newest category and network advice (the tick loads
 * both from the row). A hard, fraud, expired or do_not_try_again reading is
 * what stops the later retries (engine/retry-step.ts). The decline code is
 * written only when the error carried one, as the sequence-start flip does.
 *
 * Only on a row still `active`: a payment recovered or stopped meanwhile keeps
 * its record, and nothing else rides this batch for a zero-row match to leak
 * into. Its own batch, not the step patch's: failed_payments is a money table
 * and goes through the money Durable Object.
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
 * invoice.payment_succeeded: claim + flip failed_payments active->recovered
 * (this webhook OWNS the recovered status, never a cron) + record the recovery
 * (recovered_payments + outcomes, attributed or free baseline). All atomic.
 * The status flip is conditional on status='active' so a replay/concurrent event
 * touches zero rows.
 */
export function buildRecoverBatch(db: Db, input: RecoverBatchInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  // Conditional so a replay or concurrent event touches zero rows. The condition
  // covers failed_unrecovered as well as active: once the exhausted-sequence
  // sweep started flipping rows, an `= 'active'` check would have quietly
  // refused to record a customer who paid after the dunning cadence ran out.
  // Widened deliberately, with findRecoverableFailedPayment as its counterpart
  // on the lookup side (both would have to be narrow for the drop to happen, and
  // both are pinned by test/cron-exhausted-sequences.test.ts).
  const statusFlip = db
    .update(failedPayments)
    .set({ status: "recovered", resolvedAt: input.recoveredAt })
    .where(
      and(
        eq(failedPayments.id, input.failedPaymentId),
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
 * charge.refunded: claim + the refund MARKER on failed_payments + the
 * recovered_payments stamp. Fires on ANY refund, full or partial.
 * All three in one atomic batch, so a claim without its marker is impossible.
 *
 * TWO writes, not one, because the stamp alone is order-dependent. The stamp is
 * an UPDATE, so it can only work once a recovered_payments row exists. A refund
 * processed BEFORE invoice.payment_succeeded matched zero rows, committed its
 * claim regardless (the claim insert succeeds either way), returned 200, and was
 * never redelivered: the recovery was then recorded with refunded_at null and
 * billed at maturity. That is the overcharge this whole path exists to prevent,
 * and it was reachable from a single transient 500 on the success webhook, not
 * just from Stripe reordering events. Review HIGH-1.
 *
 * The marker closes it from the other side: it is written unconditionally, and
 * buildRecoveryBatch reads it when inserting, so a later recovery is born
 * refunded. The two halves are exhaustive because both batches run through the
 * SAME per-account money-write DO (idFromName(accountId)) and SerialMoneyCommitter
 * runs one commit at a time, so exactly one of these holds:
 *   marker commits first  -> the recovery insert's subquery sees it
 *   recovery commits first -> the stamp below finds the row
 * There is no interleaving in which both miss, so there is no residual to accept.
 *
 * Both writes take the first refund and keep it: the isNull guards make a second
 * partial refund a no-op rather than moving the disqualification later.
 */
export function buildRefundStampBatch(
  db: Db,
  input: { claim: WebhookClaimInput; failedPaymentId: string; at: Date },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(failedPayments)
      .set({ refundSignalAt: input.at })
      .where(
        and(eq(failedPayments.id, input.failedPaymentId), isNull(failedPayments.refundSignalAt)),
      ),
    db
      .update(recoveredPayments)
      .set({ refundedAt: input.at })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, input.failedPaymentId),
          isNull(recoveredPayments.refundedAt),
        ),
      ),
  ];
}

/** The conditional recovered_payments.disputed_at stamp (feeds the billable
 *  predicate, SCHEMA.md spine #3): only touches a row that is not already
 *  stamped, so a replay or a second dispute event on the same recovery is a
 *  no-op, not a second write. Shared by buildDisputeStampBatch and
 *  buildDisputeIntakeBatch (dispute intake also excludes the underlying
 *  recovery from billing when the disputed charge is resolved to one). */
function buildDisputedAtStamp(db: Db, failedPaymentId: string, at: Date) {
  return [
    // The order-independent half, as refund_signal_at is for refunds: a dispute
    // that lands BEFORE the recovery row exists stamps the failed payment, and
    // buildRecoveryBatch reads it so the recovery is born disputed. First
    // dispute wins.
    db
      .update(failedPayments)
      .set({ disputeSignalAt: at })
      .where(and(eq(failedPayments.id, failedPaymentId), isNull(failedPayments.disputeSignalAt))),
    db
      .update(recoveredPayments)
      .set({ disputedAt: at })
      .where(
        and(eq(recoveredPayments.failedPaymentId, failedPaymentId), isNull(recoveredPayments.disputedAt)),
      ),
  ] as const;
}

/** charge.dispute.created: claim + stamp recovered_payments.disputed_at (feeds the billable predicate). */
export function buildDisputeStampBatch(
  db: Db,
  input: { claim: WebhookClaimInput; failedPaymentId: string; at: Date },
): MoneyWriteBatch {
  return [buildWebhookClaim(db, input.claim), ...buildDisputedAtStamp(db, input.failedPaymentId, input.at)];
}

export interface DisputeIntakeInput {
  claim: WebhookClaimInput;
  disputeId: string;
  accountId: string;
  stripeConnectionId: string;
  stripeDisputeId: string;
  stripeChargeId: string;
  stripeCustomerId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  evidenceDeadline: Date | null;
  createdAt: Date;
  /** The failed_payments row this disputed charge recovered from, if the
   *  Stripe-read enrichment seam (Phase 8 live) resolved one. When set, the
   *  matching recovered_payments row is stamped disputed_at in the same
   *  atomic batch, so it is excluded from recovery billing immediately
   *  (never a separate write). */
  linkedFailedPaymentId: string | null;
  /** AI-drafted evidence, grounded only in real records (never fabricated;
   *  app/lib/disputes/evidence.ts). Empty when nothing grounds it. */
  evidence: EvidenceField[];
  /** What Stripe said about the charge and customer, and Recova's triage over
   *  it (app/lib/disputes/triage.ts). Absent on a caller that read nothing. */
  contextColumns?: DisputeContextColumns;
}

/**
 * charge.dispute.created (dispute intake, TASK-foxhound-dispute-intake.md):
 * claim + insert the disputes row (state: pending_review, "awaiting merchant
 * review", never auto-submitted) + insert the drafted dispute_evidence rows +
 * (when the disputed charge resolves to a known recovery) stamp
 * recovered_payments.disputed_at so the maturity-window billable predicate
 * excludes it. All atomic through the per-account money-write DO, same shape
 * as buildIntakeBatch/buildRecoverBatch (claim-with-side-effects).
 */
export function buildDisputeIntakeBatch(db: Db, input: DisputeIntakeInput): MoneyWriteBatch {
  const claim = buildWebhookClaim(db, input.claim);
  const disputeInsert = db.insert(disputes).values({
    id: input.disputeId,
    accountId: input.accountId,
    stripeDisputeId: input.stripeDisputeId,
    stripeChargeId: input.stripeChargeId,
    stripeCustomerId: input.stripeCustomerId,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    amountCents: input.amountCents,
    currency: input.currency,
    reason: input.reason,
    status: input.status,
    evidenceDeadline: input.evidenceDeadline,
    createdAt: input.createdAt,
    stripeConnectionId: input.stripeConnectionId,
    // A dispute Stripe has already closed (its closed event was processed
    // first, or this created event is a late retry) is born resolved, so it
    // is never left awaiting review or picked up by auto-submit.
    ...(input.status === "won" || input.status === "lost"
      ? {
          state: input.status === "won" ? ("resolved_won" as const) : ("resolved_lost" as const),
          resolvedAt: input.claim.receivedAt,
        }
      : { state: "pending_review" as const }),
    ...input.contextColumns,
  });
  const evidenceInserts = input.evidence.map((field) =>
    db.insert(disputeEvidence).values({
      id: crypto.randomUUID(),
      disputeId: input.disputeId,
      accountId: input.accountId,
      fieldName: field.fieldName,
      fieldValue: field.fieldValue,
      createdAt: input.createdAt,
    }),
  );
  const stamp = input.linkedFailedPaymentId
    ? buildDisputedAtStamp(db, input.linkedFailedPaymentId, input.createdAt)
    : [];
  return [claim, disputeInsert, ...evidenceInserts, ...stamp];
}

const RESOLVED_DISPUTE_STATES: DisputeState[] = ["resolved_won", "resolved_lost"];

export interface DisputeResolutionInput {
  claim: WebhookClaimInput;
  /** The account this dispute belongs to (resolved + verified at the call site).
   *  Pinned in the UPDATE WHERE so tenant isolation is DB-enforced, not
   *  caller-dependent (account-scoping audit HIGH #3), matching
   *  buildSubmissionConfirmationBatch. A foreign accountId matches zero rows. */
  accountId: string;
  stripeDisputeId: string;
  won: boolean;
  /** The disputed amount, read from the existing dispute row (the fee base). */
  amountCents: number;
  currency: string;
  /** The USD 500 cap in THIS dispute's currency, converted at resolution.
   * Null when the quote failed, which is the fail-closed
   *  case: no fee is snapshotted. */
  cap: ResolvedDisputeCap | null;
  /** Why the cap could not be resolved, stored on the row so the dispute's
   *  unbilled state has a stated reason rather than looking like a win nobody
   *  charged for. */
  capError: string | null;
  /** Whether Foxhound actually drafted AND submitted the evidence for this
   *  dispute (disputes.submitted_at set). A win Foxhound did NOT submit
   *  (merchant-fought, or auto-resolved) is never billable (PRICING.md rev 3),
   *  so no fee is snapshotted for it, keeping the UI honest (resolved_fee_cents
   *  is null) alongside the authoritative getBillableDisputes gate. */
  foxhoundSubmitted: boolean;
  resolvedAt: Date;
}

/**
 * charge.dispute.closed (5c Scope B, closes review finding L1): claim + set
 * state=resolved_won|resolved_lost, conditional on the dispute not already being
 * resolved (a replay or a second close event touches zero rows, not a second
 * fee snapshot). On a win Foxhound SUBMITTED, snapshots the capped fee via
 * disputeFeeCents onto resolved_fee_cents. A win Foxhound did not submit, or a
 * loss, snapshots no fee (a lost dispute never carries a stale won-fee; a
 * merchant-fought win is never billed, PRICING.md rev 3).
 */
export function buildDisputeResolutionBatch(db: Db, input: DisputeResolutionInput): MoneyWriteBatch {
  return [buildWebhookClaim(db, input.claim), buildDisputeResolutionUpdate(db, input)];
}

/**
 * The resolution UPDATE itself, the one writer of a dispute's resolved state
 * and fee snapshot. buildDisputeResolutionBatch rides it behind the webhook
 * claim, unchanged; the merchant's Accept (app/lib/disputes/accept.server.ts)
 * rides it as a loss Foxhound did not submit, so an accepted dispute is resolved
 * by the same statement Stripe's closing event would have used, with no fee.
 */
export function buildDisputeResolutionUpdate(db: Db, input: Omit<DisputeResolutionInput, "claim">) {
  const billableWin = input.won && input.foxhoundSubmitted;
  return db
    .update(disputes)
    .set({
      state: input.won ? "resolved_won" : "resolved_lost",
      resolvedAt: input.resolvedAt,
      // THE CAP IS RESOLVED BEFORE THIS BATCH IS BUILT. It
      // needs a Stripe FX quote, and an external call cannot live inside the
      // money batch, so process.ts fetches it and hands the result in. A
      // quote that failed arrives as a null cap and the fee is NOT
      // snapshotted: the dispute resolves, and it is simply not billable
      // until a run that can price it. Never the flat 50,000.
      resolvedFeeCents:
        billableWin && input.cap
          ? feeForCurrency(disputeFeeCents(input.amountCents, input.cap.capMinorUnits), input.currency)
          : null,
      resolvedFeeCurrency: billableWin && input.cap ? input.currency : null,
      resolvedFeeRate: input.cap?.rate ?? null,
      resolvedFeeQuoteId: input.cap?.quoteId ?? null,
      resolvedFeeRateAt: input.cap?.quotedAt ?? null,
      resolvedFeeError: input.capError ?? null,
    })
    .where(
      and(
        eq(disputes.stripeDisputeId, input.stripeDisputeId),
        eq(disputes.accountId, input.accountId),
        notInArray(disputes.state, RESOLVED_DISPUTE_STATES),
      ),
    );
}

/** claim-only batch: a verified event we resolved to nothing actionable, still claimed so replays short-circuit. */
export function buildClaimOnlyBatch(db: Db, claim: WebhookClaimInput): MoneyWriteBatch {
  return [buildWebhookClaim(db, claim)];
}

/**
 * customer.subscription.deleted where the customer still has ACTIVE failed
 * payments: legacy's involuntary-churn branch. Legacy stops those recoveries and
 * starts NO win-back, because a customer whose card failed did not choose to
 * leave. Ported under 291.
 *
 * THE TRANSITION IS 265'S, NOT LEGACY'S. Legacy fires an unconditional per-row
 * `Promise.all` and discards both results. Foxhound already has a RATIFIED
 * active-to-canceled transition in buildStopRecoveryBatch: the status UPDATE
 * CLAIMS on `status = 'active'`, and the steps UPDATE is conditioned on that
 * claim having landed via a correlated subquery. Reusing it is what keeps this
 * from seating a second writer against a ratified money transition, and it means
 * a raced or redelivered stop cannot double-resolve: the claim takes zero rows
 * the second time and the steps subquery is then reading a row this batch did
 * not cancel.
 *
 * The builder is reused UNCHANGED. It takes (accountId, failedPaymentId, now)
 * and asserts nothing about who is stopping the recovery, so a system-caused
 * stop needs no redesign, which is what 291 asked this session to determine.
 * invoice.voided's stop rides this batch too (recovery-handlers.ts).
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
 * customer.subscription.deleted: claim + the win-back sequence + its steps, all
 * atomic. Ported from legacy's handleSubscriptionDeleted; this is
 * planWinbackSteps' FIRST production caller, the planner having existed since
 * the rebuild with only the demo seeder and its own test calling it.
 *
 * EXACTLY-ONCE IS STRUCTURAL, not a second mechanism: win_back_sequences carries
 * a real UNIQUE index on stripe_subscription_id (win_back_sequences_subscription_uq,
 * schema.ts), so a redelivery's insert violates it, the whole atomic batch rolls
 * back INCLUDING the steps and the claim, and executeMoneyWrite reports
 * applied=false. That is the spine's payment-not-event principle applied to a
 * subscription: the key is the SUBSCRIPTION, never the event id, so two different
 * events for one cancellation still collapse to one sequence. No migration was
 * needed and none was written; legacy's own replay guard is a SELECT, which this
 * keeps as a cheap pre-check while the index is what actually guarantees it.
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
