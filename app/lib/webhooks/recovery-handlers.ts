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
import { applyNetworkAdvice, classifyDecline, isHardDecline, pickDeclineCode } from "~/lib/recovery/decline";
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
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";
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
 * The best decline known for a failure: the charge's code over the event's,
 * then the network advice over the code (recovery/decline.ts). With neither a
 * code nor a charge read, a promotion keeps the category and advice intake
 * stored rather than falling to "unknown". Pure.
 */
function bestDecline(
  eventCode: string | null,
  facts: DeclineFacts | null,
  stored?: { declineCategory: string; networkAdviceCode: string | null },
): { declineCode: string | null; declineCategory: DeclineCategory; chargeFacts: ChargeFacts | null } {
  const declineCode = pickDeclineCode([facts?.declineCode, eventCode]);
  const fromCode =
    declineCode || !stored ? classifyDecline(declineCode) : (stored.declineCategory as DeclineCategory);
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

async function claimOnly(ctx: WebhookContext, reason: string): Promise<WebhookOutcome> {
  const { applied } = await executeMoneyWrite(ctx.env, {
    accountId: ctx.accountId,
    idempotencyKey: ctx.idempotencyKey,
    build: (db) => buildClaimOnlyBatch(db, ctx.claim),
  });
  return applied ? { status: "ignored", reason } : { status: "duplicate" };
}

export async function handleIntake(
  ctx: WebhookContext,
  intent: IntentOf<"intake">,
): Promise<WebhookOutcome> {
  const { env, event, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
  // Per-invoice dedupe: Stripe emits one payment_failed per collection
  // attempt. The FIRST creates the row; a later one either promotes it out
  // of stripe_retrying or is a no-op claim (377(1)).
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
  // A hard decline starts its email-led sequence now even while Stripe keeps
  // a next attempt scheduled, because Stripe runs that attempt only after a
  // new payment method (decline.ts isHardDecline). The sequence's own retry
  // still waits for Stripe to stop (engine/retry-step.ts).
  const startSequence = intent.stripeGaveUp || isHardDecline(decline.declineCategory);
  if (existing) {
    if (!startSequence) return claimOnly(ctx, "stripe_still_retrying");
    // Stripe has stopped retrying, or never will on this card. The sequence
    // starts NOW, anchored on this moment rather than on the original
    // failure, which is what makes "Foxhound starts when Stripe stops" true.
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
          ...decline,
          startedAt: receivedAt,
        }),
    });
    return applied ? { status: "applied" } : { status: "duplicate" };
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

// invoice.marked_uncollectible: Stripe has written the invoice off, which is
// the other way it can be finished with a payment (377(1)). Same promotion,
// same conditional flip, so an uncollectible arriving after a final
// payment_failed plans no second sequence.
//
// It deliberately does NOT stop a sequence already running. "Mark the invoice
// as uncollectible" is one of Stripe's settings for when all retries fail, so
// for those merchants this event IS Stripe giving up and arrives just after
// the final payment_failed that started the sequence: stopping here would end
// every recovery they have. An uncollectible invoice can still be paid
// (invoices.pay accepts it), which is what the sequence is for. A void
// invoice cannot, and handleInvoiceVoided stops it.
export async function handleStripeGaveUp(
  ctx: WebhookContext,
  intent: IntentOf<"stripe_gave_up">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
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
  const decline = bestDecline(
    null,
    (await resolveFailureFacts(env, connectionId, intent.invoiceId)).decline,
    existing,
  );
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
        ...decline,
        startedAt: receivedAt,
      }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

// invoice.voided: the invoice can never be paid now, so a live recovery for it
// stops through the ratified stop transition (buildStopRecoveryBatch, via the
// involuntary-stop batch that carries the claim). The stop claims only an
// 'active' row; one still parked in stripe_retrying has no steps to run.
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

  // When the customer paid, not when the event arrived: a late or replayed
  // event must not let a later click or card update claim the payment.
  const recoveredAt = intent.paidAt ?? receivedAt;
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
    await resolveRecoveryAttribution(env, failedPaymentId, recoveredAt);
  // What Stripe took, read BEFORE the batch and outside it, as intake reads its
  // decline facts: the Durable Object batch makes no Stripe call. The read
  // never throws, and a failed one records the recovery with the fee columns
  // null; billing reads only the gross amount.
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

export async function handleRecordExpiringCard(
  ctx: WebhookContext,
  intent: IntentOf<"record_expiring_card">,
): Promise<WebhookOutcome> {
  const { env, receivedAt, accountId, connectionId, claim, idempotencyKey } = ctx;
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

// payment_method.automatically_updated: Stripe's card updater gave the customer
// a new card, so an active failed payment is retried on it now. The claim
// commits first; the retry follows, only on a first delivery, and through the
// recovery tick's own guarded retry path (retryOnUpdatedCard), never a second
// charging path. It never throws, so a failed retry cannot fail the webhook;
// the step stays pending for its scheduled run.
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

  // THE CLAWBACK, AFTER THE STAMP COMMITS (ruling 377(5)). It depends on a
  // Stripe call, so it cannot ride the batch above, and it must not be able
  // to unwind it: the refund is a fact whether or not Stripe answers.
  //
  // Only on `applied`. A replayed refund event has already had its credit
  // considered on the first delivery, and the fee line's own key would refuse
  // a second note anyway; not re-entering keeps a redelivery storm from
  // calling Stripe once per delivery.
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
