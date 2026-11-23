// Recovery-side intents of the connected-account webhook: intake, Stripe giving
// up, recovery, expiring cards and refund stamping. Dispatched from process.ts.

import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
  type DeclineCategory,
} from "~/lib/constants";
import {
  issueCreditNoteForEvidence,
  REFUND_CREDIT_DESCRIPTION,
  refundedRecoveryIdsFor,
} from "~/lib/billing/credit-note";
import { executeMoneyWrite } from "~/lib/money/execute";
import {
  applyNetworkAdvice,
  classifyDecline,
  isHardDecline,
  pickDeclineCode,
} from "~/lib/recovery/decline";
import { sendRecoveryNotification } from "~/lib/recovery/merchant-notification.server";
import { buildCandidateUpsert, isInsideLeadWindow } from "~/lib/cron/expiring-cards";
import { retryOnUpdatedCard } from "~/lib/cron/recovery-tick";

import {
  buildClaimOnlyBatch,
  buildIntakeBatch,
  buildInvoluntaryStopBatch,
  buildRecoverBatch,
  buildRefundStampBatch,
  buildSequenceStartBatch,
  type ChargeFacts,
} from "./batches";
import {
  claimOnly,
  type IntentOf,
  type WebhookContext,
  type WebhookOutcome,
} from "./handler-context";
import {
  findActiveFailedPayment,
  findRecoverableFailedPayment,
  resolveExpiringCard,
  resolveRecoveredChargeFee,
  resolveRecoveryAttribution,
  resolveRefundedFailedPayment,
  tryWinbackReactivationFromInvoice,
  type DeclineFacts,
  resolveFailureFacts,
} from "./lookups";

/**
 * The best decline known for a failure: the charge's code over the event's, then the network advice
 * over the code (recovery/decline.ts). Pure.
 */
function bestDecline(
  eventCode: string | null,
  facts: DeclineFacts | null,
  stored?: { declineCategory: string; networkAdviceCode: string | null },
): {
  declineCode: string | null;
  declineCategory: DeclineCategory;
  chargeFacts: ChargeFacts | null;
} {
  const declineCode = pickDeclineCode([facts?.declineCode, eventCode]);
  const fromCode =
    declineCode || !stored
      ? classifyDecline(declineCode)
      : (stored.declineCategory as DeclineCategory);
  const advice = facts ? facts.networkAdviceCode : (stored?.networkAdviceCode ?? null);
  return {
    declineCode,
    declineCategory: applyNetworkAdvice(fromCode, advice),
    chargeFacts: facts
      ? {
          networkAdviceCode: facts.networkAdviceCode,
          networkDeclineCode: facts.networkDeclineCode,
          cardFunding: facts.cardFunding,
          cardBrand: facts.cardBrand,
          cardCountry: facts.cardCountry,
        }
      : null,
  };
}

/** Paid or void: Stripe has nothing left to collect on the invoice. */
function invoiceClosed(status: string | null): boolean {
  return status === "paid" || status === "void";
}

/**
 * Starts the sequence for a payment parked in stripe_retrying, anchored on this moment rather than
 * the original failure. KEYED ON THE PAYMENT, NOT THE EVENT, so the payment_failed promotion and
 * the later event that also finds the payment parked cannot each start a sequence for one invoice.
 */
async function startSequenceNow(
  ctx: WebhookContext,
  failedPaymentId: string,
  decline: ReturnType<typeof bestDecline>,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: `sequence-start:${failedPaymentId}`,
    build: (db) =>
      buildSequenceStartBatch(db, {
        claim,
        failedPaymentId,
        accountId,
        ...decline,
        startedAt: receivedAt,
      }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleIntake(
  ctx: WebhookContext,
  intent: IntentOf<"intake">,
): Promise<WebhookOutcome> {
  const { env, event, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // Per-invoice dedupe: Stripe emits one payment_failed per collection
  // attempt. The FIRST creates the row; a later one either promotes it out
  // of stripe_retrying or is a no-op claim.
  const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
  if (existing && existing.status !== FAILED_PAYMENT_STATUS_STRIPE_RETRYING) {
    return claimOnly(ctx, "duplicate_attempt");
  }
  // The charge is read first, so the cadence is planned from the best
  // category known, and the invoice with it: a late or redelivered
  // payment_failed for an invoice since paid or voided opens no dunning.
  const facts = await resolveFailureFacts(env, connectionId, intent.invoiceId);
  if (invoiceClosed(facts.invoiceStatus)) return claimOnly(ctx, "invoice_closed");
  const decline = bestDecline(intent.declineCode, facts.decline, existing ?? undefined);
  // A hard decline starts its email-led sequence now even while Stripe keeps a next attempt
  // scheduled, because Stripe runs that attempt only after a new payment method (decline.ts
  // isHardDecline).
  const startSequence = intent.stripeGaveUp || isHardDecline(decline.declineCategory);
  if (existing) {
    if (!startSequence) return claimOnly(ctx, "stripe_still_retrying");
    // Stripe has stopped retrying, or never will on this card. The sequence
    // starts NOW, anchored on this moment rather than on the original
    // failure, which is what makes "Foxhound starts when Stripe stops" true.
    return startSequenceNow(ctx, existing.id, decline);
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
        subscriptionId: intent.subscriptionId,
        customerEmail: intent.customerEmail,
        customerName: intent.customerName,
        amountCents: intent.amountCents,
        currency: intent.currency,
        ...decline,
        detectedAt: receivedAt,
        startSequence,
      }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

// invoice.marked_uncollectible: Stripe has written the invoice off, which is the other way it can
// be finished with a payment.
export async function handleStripeGaveUp(
  ctx: WebhookContext,
  intent: IntentOf<"stripe_gave_up">,
): Promise<WebhookOutcome> {
  const { env, accountId, connectionId } = ctx;
  const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
  if (!existing || existing.status !== FAILED_PAYMENT_STATUS_STRIPE_RETRYING) {
    return claimOnly(ctx, existing ? "sequence_already_started" : "no_failed_payment");
  }
  const decline = bestDecline(
    null,
    (await resolveFailureFacts(env, connectionId, intent.invoiceId)).decline,
    existing,
  );
  return startSequenceNow(ctx, existing.id, decline);
}

// invoice.voided: the invoice can never be paid now, so a live recovery for it stops through the
// ratified stop transition (buildStopRecoveryBatch, via the involuntary-stop batch that carries the
// claim). The stop claims only an 'active' row; one still parked in stripe_retrying has no steps to
// run.
export async function handleInvoiceVoided(
  ctx: WebhookContext,
  intent: IntentOf<"invoice_voided">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, claim, idempotencyKey } = ctx;
  const existing = await findActiveFailedPayment(env, accountId, intent.invoiceId);
  if (!existing || existing.status !== FAILED_PAYMENT_STATUS_ACTIVE) {
    return claimOnly(ctx, existing ? "sequence_not_started" : "no_failed_payment");
  }
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildInvoluntaryStopBatch(db, {
        claim,
        accountId,
        failedPaymentIds: [existing.id],
        now: receivedAt,
      }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleRecover(
  ctx: WebhookContext,
  intent: IntentOf<"recover">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // THE PREFILTER IS A COST GUARD, NEVER THE MATCH.
  await tryWinbackReactivationFromInvoice(env, {
    accountId,
    connectionId,
    customerId: intent.customerId,
    subscriptionId: intent.subscriptionId,
    now: receivedAt,
  });

  // When the customer paid, not when the event arrived: a late or replayed
  // event must not let a later click or card update claim the payment.
  const recoveredAt = intent.paidAt ?? receivedAt;
  const failedPaymentId = await findRecoverableFailedPayment(env, accountId, intent.invoiceId);
  if (!failedPaymentId) {
    // A normal renewal payment (no active failure): nothing to recover, claim only.
    return claimOnly(ctx, "no_active_failure");
  }
  const { attribution, recoveredByStepId, recoveryMethod } = await resolveRecoveryAttribution(
    env,
    failedPaymentId,
    recoveredAt,
  );
  // What Stripe took, read BEFORE the batch and outside it, as intake reads its decline facts: the
  // Durable Object batch makes no Stripe call. The read never throws, and a failed one records the
  // recovery with the fee columns null; billing reads only the gross amount.
  const chargeFee = await resolveRecoveredChargeFee(env, connectionId, intent.invoiceId);
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
        recoveredAt,
        attribution,
        recoveredByStepId,
        recoveryMethod,
        idempotencyKey: failedPaymentId,
        chargeFee,
      }),
  });
  // THE MERCHANT NOTIFICATION, after the money write has committed and changing nothing about it.
  if (applied) {
    await sendRecoveryNotification(env, { accountId, failedPaymentId });
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleRecordExpiringCard(
  ctx: WebhookContext,
  intent: IntentOf<"record_expiring_card">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // WRITER TWO. The claim is the money write, as every branch here does; the candidate upsert rides
  // the same batch so a replayed event cannot double-write.
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

// payment_method.automatically_updated: Stripe's card updater gave the customer a new card, so an
// active failed payment is retried on it now. The claim commits first; the retry follows, only on a
// first delivery, and through the recovery tick's own guarded retry path (retryOnUpdatedCard),
// never a second charging path. It never throws, so a failed retry cannot fail the webhook; the
// step stays pending for its scheduled run.
export async function handleCardAutoUpdated(
  ctx: WebhookContext,
  intent: IntentOf<"card_auto_updated">,
): Promise<WebhookOutcome> {
  const { env, accountId, claim, idempotencyKey } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, claim),
  });
  if (!applied) return { status: "duplicate" };
  const attempted = await retryOnUpdatedCard(env, accountId, intent.customerId);
  return attempted > 0 ? { status: "applied" } : { status: "ignored", reason: "no_retry_due" };
}

export async function handleStampRefund(
  ctx: WebhookContext,
  intent: IntentOf<"stamp_refund">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // stamp_refund: the fee shrinks by the refunded share, and a full refund owes none
  // (buildRefundStampBatch). resolveRefundedFailedPayment THROWS on a transient failure instead of
  // resolving to null, and that asymmetry is deliberate: claiming a refund we could not stamp is
  // the one direction that overcharges a merchant, so an unresolvable refund leaves the event
  // unclaimed and 500s for redelivery.
  const refundedFailedPaymentId = await resolveRefundedFailedPayment(
    env,
    accountId,
    connectionId,
    intent.paymentIntentId,
  );
  if (!refundedFailedPaymentId) {
    return claimOnly(ctx, "refund_not_ours");
  }
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildRefundStampBatch(db, {
        claim,
        accountId,
        failedPaymentId: refundedFailedPaymentId,
        at: receivedAt,
        refundedCents: intent.refundedCents,
        full: intent.full,
      }),
  });

  // THE CLAWBACK, AFTER THE STAMP COMMITS. It depends on a Stripe call, so it cannot ride the batch
  // above, and it must not be able to unwind it: the refund is a fact whether or not Stripe
  // answers. Only on `applied`.
  if (applied) {
    for (const recoveredPaymentId of await refundedRecoveryIdsFor(env, refundedFailedPaymentId)) {
      await issueCreditNoteForEvidence(
        env,
        { recoveredPaymentId },
        { now: receivedAt, description: REFUND_CREDIT_DESCRIPTION },
      );
    }
  }
  return applied ? { status: "applied" } : { status: "duplicate" };
}
