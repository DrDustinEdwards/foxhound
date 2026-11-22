// The rest of the dispute lifecycle on the connected-account webhook, after intake and resolution
// (dispute-handlers.ts): charge.dispute.updated keeps the stored row current,
// charge.dispute.funds_withdrawn and funds_reinstated record the money Stripe moved, and
// charge.dispute.closed as warning_closed closes an inquiry. Only charge.dispute.closed with won or
// lost resolves a dispute and snapshots a fee (buildDisputeResolutionUpdate).

import { and, eq, isNull, lt, notInArray, or } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputeBalanceTransactions, disputes } from "~/db";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";
import type { DisputeFundsMovement } from "~/lib/disputes/stripe-dispute";
import { executeMoneyWrite } from "~/lib/money/execute";

import { buildWebhookClaim, type WebhookClaimInput } from "./batches";
import type { IntentOf, WebhookContext, WebhookOutcome } from "./handler-context";

const OPEN_ONLY = notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]);

/** One insert per balance transaction, a redelivery or a later event carrying
 *  the same transaction adding nothing (the unique index on its Stripe id). */
function buildFundsInserts(
  db: Db,
  input: {
    accountId: string;
    stripeDisputeId: string;
    funds: DisputeFundsMovement[];
    recordedAt: Date;
  },
) {
  return input.funds.map((f) =>
    db
      .insert(disputeBalanceTransactions)
      .values({
        accountId: input.accountId,
        stripeDisputeId: input.stripeDisputeId,
        stripeBalanceTransactionId: f.stripeBalanceTransactionId,
        kind: f.kind,
        amountCents: f.amountCents,
        feeCents: f.feeCents,
        currency: f.currency,
        occurredAt: f.occurredAt,
        createdAt: input.recordedAt,
      })
      .onConflictDoNothing({ target: disputeBalanceTransactions.stripeBalanceTransactionId }),
  );
}

/**
 * charge.dispute.updated: Stripe's status (needs_response, under_review and the inquiry statuses),
 * the evidence deadline, has_evidence and submission_count, and the amount and reason. Only an open
 * row is touched, and only by an event newer than the last one applied.
 */
function buildDisputeUpdatedBatch(
  db: Db,
  input: {
    claim: WebhookClaimInput;
    accountId: string;
    intent: IntentOf<"dispute_updated">;
    recordedAt: Date;
  },
): MoneyWriteBatch {
  const { intent } = input;
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(disputes)
      .set({
        status: intent.status,
        evidenceDeadline: intent.evidenceDeadline,
        stripeHasEvidence: intent.hasEvidence,
        stripeSubmissionCount: intent.submissionCount,
        amountCents: intent.amountCents,
        reason: intent.reason,
        stripeSyncedAt: intent.eventCreatedAt,
      })
      .where(
        and(
          eq(disputes.stripeDisputeId, intent.stripeDisputeId),
          eq(disputes.accountId, input.accountId),
          OPEN_ONLY,
          or(isNull(disputes.stripeSyncedAt), lt(disputes.stripeSyncedAt, intent.eventCreatedAt)),
        ),
      ),
    ...buildFundsInserts(db, {
      ...input,
      stripeDisputeId: intent.stripeDisputeId,
      funds: intent.funds,
    }),
  ];
}

/** charge.dispute.funds_withdrawn and funds_reinstated: the balance transactions
 *  the dispute carries. Keyed on the Stripe dispute id, so it records whether or
 *  not intake has written the dispute row yet. */
function buildDisputeFundsBatch(
  db: Db,
  input: {
    claim: WebhookClaimInput;
    accountId: string;
    intent: IntentOf<"dispute_funds">;
    recordedAt: Date;
  },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    ...buildFundsInserts(db, {
      ...input,
      stripeDisputeId: input.intent.stripeDisputeId,
      funds: input.intent.funds,
    }),
  ];
}

/**
 * No fee, no credit note and no won or lost notice, because nothing was won or lost; it only stops
 * counting as open.
 */
function buildInquiryClosedBatch(
  db: Db,
  input: { claim: WebhookClaimInput; accountId: string; stripeDisputeId: string; closedAt: Date },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(disputes)
      .set({ state: "inquiry_closed", status: "warning_closed", resolvedAt: input.closedAt })
      .where(
        and(
          eq(disputes.stripeDisputeId, input.stripeDisputeId),
          eq(disputes.accountId, input.accountId),
          OPEN_ONLY,
        ),
      ),
  ];
}

export async function handleDisputeUpdated(
  ctx: WebhookContext,
  intent: IntentOf<"dispute_updated">,
): Promise<WebhookOutcome> {
  const { env, accountId, claim, idempotencyKey, receivedAt } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildDisputeUpdatedBatch(db, { claim, accountId, intent, recordedAt: receivedAt }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleDisputeFunds(
  ctx: WebhookContext,
  intent: IntentOf<"dispute_funds">,
): Promise<WebhookOutcome> {
  const { env, accountId, claim, idempotencyKey, receivedAt } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) => buildDisputeFundsBatch(db, { claim, accountId, intent, recordedAt: receivedAt }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}

export async function handleInquiryClosed(
  ctx: WebhookContext,
  intent: IntentOf<"inquiry_closed">,
): Promise<WebhookOutcome> {
  const { env, accountId, claim, idempotencyKey, receivedAt } = ctx;
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey,
    build: (db) =>
      buildInquiryClosedBatch(db, {
        claim,
        accountId,
        stripeDisputeId: intent.stripeDisputeId,
        closedAt: receivedAt,
      }),
  });
  return applied ? { status: "applied" } : { status: "duplicate" };
}
