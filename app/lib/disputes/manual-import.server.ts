import { getDb } from "~/db";
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { readDisputeProductDescription, readDisputesEnabled } from "~/lib/disputes/queries.server";
import { disputeIntakeFields, isStripeDisputeId } from "~/lib/disputes/stripe-dispute";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { findActiveConnection } from "~/lib/stripe/connections.server";
import { decryptToken } from "~/lib/stripe/encryption";
import { mergeEvidence, readDisputeIntakeContext } from "./context.server";
import { buildDisputeIntakeBatch } from "~/lib/webhooks/dispute-batches";
import { resolveDisputedRecovery } from "~/lib/webhooks/lookups";

//   1. The claim key is `manual_dispute:{stripeDisputeId}` (MANUAL_CLAIM_PREFIX
//      below). The Stripe dispute id is nature's idempotency key for this
//      object: it is stable, it is the thing being imported, and it is the same
//      value however many times the merchant clicks. Two clicks collapse in the
//      per-account money DO, whose seen-set and whose webhook_events unique
//      index both key on it.
//   2. The write goes through buildDisputeIntakeBatch, the SAME batch builder
//      the charge.dispute.created webhook uses, so a manually imported dispute
//      is indistinguishable downstream from a webhook-imported one: same
//      pending_review state, same drafted evidence rows, same conditional
//      recovered_payments.disputed_at stamp excluding the underlying recovery
//      from billing.
//   3. `disputes_stripe_dispute_uq` is the database backstop. When the two
//      paths race, their CLAIM keys differ (this prefix against the Stripe
//      event id), so the claim cannot collide; the dispute INSERT collides
//      instead, the whole atomic batch rolls back, and SerialMoneyCommitter
//      reads the unique violation as applied=false. Manual-then-webhook and
//      webhook-then-manual therefore converge on ONE row whichever arrives
//      first. That index is not added here: it has existed since migration
//      0000 and was verified present in production D1 (3ad240ed) this session.

/**
 * The manual-import claim key prefix. Exported so a test asserts the KEY the
 * code derives rather than re-deriving one of its own.
 */
const MANUAL_CLAIM_PREFIX = "manual_dispute:";

/**
 * The webhook_events.event_type recorded for a manual import, so the claim row
 * says what it was rather than impersonating a Stripe event.
 */
export const MANUAL_CLAIM_EVENT_TYPE = "foxhound.dispute.manual_import";

/**
 * The money-DO idempotency key AND the webhook_events claim id for importing
 * one dispute. Derived from the dispute id ALONE: no clock, no randomness, no
 * account, so two clicks in the same second and two clicks a week apart produce
 * the same key and collapse to one row.
 */
export function manualImportClaimKey(stripeDisputeId: string): string {
  return `${MANUAL_CLAIM_PREFIX}${stripeDisputeId}`;
}

export type ManualImportResult =
  | { status: "imported"; disputeId: string }
  | { status: "already_imported" }
  | { status: "invalid_id" }
  | { status: "disputes_disabled" }
  | { status: "not_connected" }
  | { status: "not_found" };

/**
 * Import one dispute by its Stripe id into `accountId`.
 *
 * The connected account's OAuth access token IS an API key for that account, so
 * retrieving a dispute belonging to somebody else's Stripe account fails at
 * Stripe with a not-found and never reaches a write.
 */
export async function importDisputeFromStripe(
  env: Env,
  accountId: string,
  rawDisputeId: string,
  now: Date,
): Promise<ManualImportResult> {
  const stripeDisputeId = rawDisputeId.trim();
  if (!isStripeDisputeId(stripeDisputeId)) return { status: "invalid_id" };
  if (!(await readDisputesEnabled(getDb(env), accountId))) {
    console.info(
      `manual dispute import ${stripeDisputeId}: Disputes is off for account ${accountId}; not created`,
    );
    return { status: "disputes_disabled" };
  }

  const connection = await findActiveConnection(getDb(env), accountId);
  if (!connection?.stripeAccessToken) return { status: "not_connected" };

  const token = await decryptToken(env, connection.stripeAccessToken);
  const stripe = getConnectedStripe(token);

  let fields;
  try {
    const dispute = await stripe.disputes.retrieve(stripeDisputeId);
    fields = disputeIntakeFields(dispute, now);
  } catch (err) {
    // Stripe's 404 (resource_missing): a dispute on another account, a typo, or
    // a deleted object. The same answer to the merchant and the same non-event
    // to the ledger: nothing is written.
    if (isStripeNotFound(err)) return { status: "not_found" };
    throw err;
  }
  // A dispute carrying no charge is the webhook parser's own `no_charge`
  // ignore. There is nothing to attach evidence or a recovery link to.
  if (!fields) return { status: "not_found" };

  // The same enrichment seam the webhook runs, so the imported row carries the
  // recovery link and the grounded evidence a webhook-imported one would.
  const linked = await resolveDisputedRecovery(
    env,
    accountId,
    connection.id,
    fields.paymentIntentId,
  );
  const facts = buildEvidenceFacts(
    linked?.failedPayment ?? null,
    linked?.steps ?? [],
    await readDisputeProductDescription(getDb(env), accountId),
  );
  const stripeContext = await readDisputeIntakeContext(env, {
    accountId,
    connectionId: connection.id,
    stripeDisputeId: fields.stripeDisputeId,
    chargeId: fields.chargeId,
    customerId: linked?.failedPayment.stripeCustomerId ?? null,
    amountCents: fields.amountCents,
    reason: fields.reason,
  });
  const evidence = mergeEvidence(
    stripeContext.evidence,
    await draftDisputeEvidence(env, facts, {
      source: "dispute_evidence",
      accountId,
      relatedId: fields.stripeDisputeId,
    }),
  );

  const disputeId = crypto.randomUUID();
  const { applied } = await executeMoneyWrite(env, {
    accountId,
    idempotencyKey: manualImportClaimKey(fields.stripeDisputeId),
    build: (db) =>
      buildDisputeIntakeBatch(db, {
        claim: {
          stripeEventId: manualImportClaimKey(fields.stripeDisputeId),
          eventType: MANUAL_CLAIM_EVENT_TYPE,
          accountId,
          receivedAt: now,
          payload: { stripeDisputeId: fields.stripeDisputeId, source: "manual_import" },
        },
        disputeId,
        accountId,
        stripeConnectionId: connection.id,
        stripeDisputeId: fields.stripeDisputeId,
        stripeChargeId: fields.chargeId,
        stripeCustomerId:
          linked?.failedPayment.stripeCustomerId ?? stripeContext.context.customerId,
        customerEmail: linked?.failedPayment.customerEmail ?? stripeContext.context.customerEmail,
        customerName: linked?.failedPayment.customerName ?? stripeContext.context.customerName,
        amountCents: fields.amountCents,
        currency: fields.currency,
        reason: fields.reason,
        status: fields.status,
        evidenceDeadline: fields.evidenceDeadline,
        createdAt: fields.createdAt,
        linkedFailedPaymentId: linked?.failedPayment.id ?? null,
        evidence,
        contextColumns: stripeContext.columns,
      }),
  });

  // applied=false is the convergence, not a failure: either this exact import
  // already ran (the claim key collided) or the dispute is already on the books
  // from the webhook (the unique index collided and rolled the batch back).
  return applied ? { status: "imported", disputeId } : { status: "already_imported" };
}

/** Stripe's answer for an object that does not exist on this account. */
function isStripeNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; code?: unknown };
  return e.statusCode === 404 || e.code === "resource_missing";
}
