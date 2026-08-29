import { and, eq, isNull } from "drizzle-orm";

import { getDb, stripeConnections } from "~/db";
import { buildEvidenceFacts, draftDisputeEvidence } from "~/lib/disputes/evidence";
import { disputeIntakeFields, isStripeDisputeId } from "~/lib/disputes/stripe-dispute";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import { buildDisputeIntakeBatch } from "~/lib/webhooks/batches";
import { resolveDisputedRecovery } from "~/lib/webhooks/process";

// Manual dispute import: legacy's "Sync dispute from Stripe" control
// (app/(app)/disputes/dashboard/SyncDisputeLink.tsx, backed by
// app/api/disputes/sync/route.ts), built in FOXHOUND'S STRONGER FORM as ruled by
// 400 halt ruling 1.
//
// WHAT LEGACY DOES AND WHY IT IS NOT PORTED VERBATIM. Legacy retrieves the
// dispute, guards against a double import with a pre-check SELECT, inserts a
// minimal row, then re-enters its webhook handler with a SYNTHESISED event id
// (`sync_${Date.now()}`). That synthesised id is the problem: it is fresh on
// every click, so it is not an idempotency key at all, and the only thing
// standing between two clicks and two dispute rows is a SELECT that ran before
// the INSERT. That is a read-then-write race on a row that gates a 20%-of-won
// fee.
//
// FOXHOUND'S FORM, and the three properties it buys:
//
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
//
// NOTHING HERE RUNS INSIDE THE DO BATCH THAT DEPENDS ON STRIPE. The retrieve and
// the enrichment happen first and the batch is built from their results, which
// is the standing rule that a write depending on an external API call cannot
// live inside the batch.

/** The manual-import claim key prefix. Exported so a test asserts the KEY the
 *  code derives rather than re-deriving one of its own. */
export const MANUAL_CLAIM_PREFIX = "manual_dispute:";

/** The webhook_events.event_type recorded for a manual import, so the claim row
 *  says what it was rather than impersonating a Stripe event. */
export const MANUAL_CLAIM_EVENT_TYPE = "foxhound.dispute.manual_import";

/** The money-DO idempotency key AND the webhook_events claim id for importing
 *  one dispute. Derived from the dispute id ALONE: no clock, no randomness, no
 *  account, so two clicks in the same second and two clicks a week apart
 *  produce the same key and collapse to one row. */
export function manualImportClaimKey(stripeDisputeId: string): string {
  return `${MANUAL_CLAIM_PREFIX}${stripeDisputeId}`;
}

export type ManualImportResult =
  | { status: "imported"; disputeId: string }
  | { status: "already_imported" }
  | { status: "invalid_id" }
  | { status: "not_connected" }
  | { status: "not_found" };

/** The account's Stripe connection to read from: the earliest-connected
 *  still-active one, the established precedent shared by the Intelligence sync
 *  and the settings pages (gotcha #22). */
async function resolveAccountConnection(
  env: Env,
  accountId: string,
): Promise<{ id: string; stripeAccessToken: string | null } | null> {
  const db = getDb(env);
  const rows = await db
    .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt)))
    .orderBy(stripeConnections.connectedAt)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Import one dispute by its Stripe id into `accountId`.
 *
 * ACCOUNT SCOPING IS THE TOKEN, not a filter this function applies. The
 * connected account's OAuth access token IS an API key for that account, so
 * retrieving a dispute belonging to somebody else's Stripe account fails at
 * Stripe with a not-found and never reaches a write. There is no code path here
 * that could be pointed at another account's dispute by changing the posted
 * value, which is why legacy's extra `charges.retrieve` cross-check has no
 * counterpart: legacy needs it because it passes `stripeAccount` as a header on
 * a PLATFORM key, and a header is a claim about scope rather than scope itself.
 */
export async function importDisputeFromStripe(
  env: Env,
  accountId: string,
  rawDisputeId: string,
  now: Date,
): Promise<ManualImportResult> {
  const stripeDisputeId = rawDisputeId.trim();
  if (!isStripeDisputeId(stripeDisputeId)) return { status: "invalid_id" };

  const connection = await resolveAccountConnection(env, accountId);
  if (!connection?.stripeAccessToken) return { status: "not_connected" };

  const token = await decryptToken(env, connection.stripeAccessToken);
  const stripe = getConnectedStripe(token);

  let fields;
  try {
    const dispute = await stripe.disputes.retrieve(stripeDisputeId);
    fields = disputeIntakeFields(dispute, now);
  } catch {
    // A dispute on another account, a typo, or a deleted object all land here.
    // They are the same answer to the merchant and the same non-event to the
    // ledger: nothing is written.
    return { status: "not_found" };
  }
  // A dispute carrying no charge is the webhook parser's own `no_charge`
  // ignore. There is nothing to attach evidence or a recovery link to.
  if (!fields) return { status: "not_found" };

  // The same enrichment seam the webhook runs, so the imported row carries the
  // recovery link and the grounded evidence a webhook-imported one would.
  const linked = await resolveDisputedRecovery(env, accountId, connection.id, fields.paymentIntentId);
  const facts = buildEvidenceFacts(linked?.failedPayment ?? null, linked?.steps ?? []);
  const evidence = await draftDisputeEvidence(env, facts);

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
        stripeCustomerId: linked?.failedPayment.stripeCustomerId ?? null,
        customerEmail: linked?.failedPayment.customerEmail ?? null,
        customerName: linked?.failedPayment.customerName ?? null,
        amountCents: fields.amountCents,
        currency: fields.currency,
        reason: fields.reason,
        status: fields.status,
        evidenceDeadline: fields.evidenceDeadline,
        createdAt: fields.createdAt,
        linkedFailedPaymentId: linked?.failedPayment.id ?? null,
        evidence,
      }),
  });

  // applied=false is the convergence, not a failure: either this exact import
  // already ran (the claim key collided) or the dispute is already on the books
  // from the webhook (the unique index collided and rolled the batch back).
  return applied ? { status: "imported", disputeId } : { status: "already_imported" };
}
