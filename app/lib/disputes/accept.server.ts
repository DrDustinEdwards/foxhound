import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputes, outcomes } from "~/db";
import type { DisputeState } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import { buildDisputeResolutionUpdate } from "~/lib/webhooks/batches";

import { canApprove } from "./approval";

// ACCEPT DISPUTE (J06, job_4f4c9c2f5383). Recova's spec, read whole:
//   app/api/disputes/accept/route.ts          blob d85b5761, 5,069 bytes
//   components/disputes/DisputeActionBar.tsx  blob c73b381a, 2,731 bytes
//   hooks/useDisputeActions.ts                blob b650cd6d, 9,172 bytes
//
// Recova's order, kept: refuse a dispute that is no longer open, close it at
// Stripe on the connected account, and only then write. Recova then marked the
// row lost with submitted_by left null ("no Recova fee on accepted disputes")
// and recorded the outcome dispute_accepted with outcome "accepted".
//
// THE STATE IS THE EXISTING WRITER'S. An accepted dispute is resolved_lost,
// written by buildDisputeResolutionUpdate, the same statement Stripe's closing
// event uses, as a loss Foxhound did not submit: no fee can be snapshotted, and
// when Stripe's charge.dispute.closed arrives it finds the dispute resolved and
// only sends the lost notice (Recova's handleDisputeClosed did the same).
//
// ONE MONEY BATCH through the per-account Durable Object, keyed on the dispute:
// the resolution and its outcome row commit together or not at all, and a
// second Accept of the same dispute is a no-op. The outcome insert reads its
// account from the dispute row itself, so an id from another account writes
// nothing (RULES.md 3.9, 4.6).
//
// A STRIPE FAILURE WRITES NOTHING, AND ONLY STRIPE'S OWN "NO" IS CALLED ONE
// (PR 149 review). Recova returned stripe_close_failed with Stripe's message
// for every throw. Here only a 4xx answer (Stripe read the request and refused
// it) says "Stripe did not accept the dispute". A 5xx, a dropped connection or
// timeout, or a 409 from a concurrent request on the same idempotency key
// leaves the result unknown: Stripe may already have conceded the dispute, so
// the merchant is told to check it in Stripe, as the approve path does.
//
// ONE STRIPE CALL PER DISPUTE. The close carries the idempotency key
// `dispute-accept:<dispute id>`, so two tabs that both pass the state check
// make one close at Stripe; the second gets the first's result back.
//
// NOT WHILE AN APPROVAL STANDS (PR 149 review, LOW). Once the merchant has
// approved the evidence, a submission is in flight, was rejected, or is
// unconfirmed, and conceding the dispute under it would race the submission.
// Accept is refused until that is settled. Whether a rejected submission may
// be re-approved or accepted is the open question in the J06 pull request.
//
// THE OUTCOME ROW IS INSERTED HERE, NOT THROUGH recordOutcome. recordOutcome
// runs its own money write; the accepted state and its outcome must commit in
// one batch, so the insert is a statement in this batch, keyed like
// recordOutcome's rows (idempotency_key, unique). Named for the seat in the
// J06 pull request: it is a third insert site for outcomes.

export type AcceptDisputeResult = { status: "accepted" } | { status: "error"; message: string };

export interface AcceptDisputeInput {
  accountId: string;
  disputeId: string;
  stripeDisputeId: string;
  /** The dispute's state as just read; a submitted or resolved one is refused. */
  state: string;
  amountCents: number;
  currency: string;
  /** Encrypted stripe_connections.stripe_access_token of the dispute's connection. */
  connectionAccessToken: string;
  acceptedAt: Date;
  /** A dispute_approvals row exists for the dispute (read with the state). */
  hasApproval: boolean;
}

export const ACCEPT_CLOSED_MESSAGE = "This dispute is already closed or submitted, so it cannot be accepted.";
export const ACCEPT_APPROVED_MESSAGE =
  "This dispute's evidence has been approved for submission, so it cannot be accepted here.";
// STRIPE REPLAYS ITS ANSWER (job_2663d92094ab). The close carries a stable key
// (stripeCloseIdempotencyKey), and Stripe returns the stored result of a keyed
// request for 24 hours, a 500 included. The key stays stable on purpose: it is
// what keeps two tabs or two clicks to one close. So the message says a retry
// may repeat the answer, rather than varying the key on a retry.
export const ACCEPT_UNKNOWN_MESSAGE =
  "Something went wrong while accepting. Stripe may or may not have closed this dispute, so check it in Stripe before trying again. If Stripe reported an error, trying again here within 24 hours gets the same answer.";

/** The Stripe idempotency key for closing one dispute. */
export function stripeCloseIdempotencyKey(disputeId: string): string {
  return `dispute-accept:${disputeId}`;
}

/** The outcome Recova recorded, its event and its words. */
export const DISPUTE_ACCEPTED_EVENT = "dispute_accepted";
export const DISPUTE_ACCEPTED_OUTCOME = "accepted";

export function acceptIdempotencyKey(disputeId: string): string {
  return `dispute-accepted:${disputeId}`;
}

/** The accepted state and its outcome, as one batch. */
export function buildDisputeAcceptBatch(
  db: Db,
  input: Pick<AcceptDisputeInput, "accountId" | "disputeId" | "stripeDisputeId" | "amountCents" | "currency" | "acceptedAt">,
): MoneyWriteBatch {
  const key = acceptIdempotencyKey(input.disputeId);
  return [
    buildDisputeResolutionUpdate(db, {
      accountId: input.accountId,
      stripeDisputeId: input.stripeDisputeId,
      won: false,
      amountCents: input.amountCents,
      currency: input.currency,
      cap: null,
      capError: null,
      foxhoundSubmitted: false,
      resolvedAt: input.acceptedAt,
    }),
    db.insert(outcomes).select(
      db
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          accountId: disputes.accountId,
          product: sql<string>`'disputes'`.as("product"),
          eventType: sql<string>`${DISPUTE_ACCEPTED_EVENT}`.as("event_type"),
          eventData: sql<string>`${JSON.stringify({ dispute_id: input.stripeDisputeId })}`.as("event_data"),
          outcome: sql<string>`${DISPUTE_ACCEPTED_OUTCOME}`.as("outcome"),
          outcomeAt: sql<number>`${input.acceptedAt.getTime()}`.as("outcome_at"),
          createdAt: sql<number>`${input.acceptedAt.getTime()}`.as("created_at"),
          idempotencyKey: sql<string>`${key}`.as("idempotency_key"),
          attributionKind: sql<null>`null`.as("attribution_kind"),
          attributedRef: sql<null>`null`.as("attributed_ref"),
        })
        .from(disputes)
        .where(and(eq(disputes.id, input.disputeId), eq(disputes.accountId, input.accountId))),
    ),
  ];
}

/** Stripe answered and refused: a 4xx other than a concurrent idempotent
 *  request (409) or a rate limit (429), neither of which says what happened. */
function isDefiniteRefusal(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

export type CloseResult = { ok: true } | { ok: false; refused: true; error: string } | { ok: false; refused: false };

/** Close the dispute at Stripe: Stripe's "accept", which concedes it. */
export async function closeDisputeWithClient(
  stripe: Stripe,
  stripeDisputeId: string,
  idempotencyKey: string,
): Promise<CloseResult> {
  try {
    await stripe.disputes.close(stripeDisputeId, {}, { idempotencyKey });
    return { ok: true };
  } catch (error) {
    if (isDefiniteRefusal(error)) {
      return { ok: false, refused: true, error: error instanceof Error ? error.message : "Stripe refused the request" };
    }
    console.error("dispute close at Stripe has an unknown result", error);
    return { ok: false, refused: false };
  }
}

/**
 * Accept one dispute. Never throws for an expected refusal; a database failure
 * after Stripe closed the dispute is reported in words that say so, because the
 * merchant must not be told it failed when Stripe has already conceded it.
 */
export async function acceptDispute(
  env: Env,
  input: AcceptDisputeInput,
  deps: { stripe?: Stripe } = {},
): Promise<AcceptDisputeResult> {
  if (!canApprove(input.state as DisputeState)) {
    return { status: "error", message: ACCEPT_CLOSED_MESSAGE };
  }
  if (input.hasApproval) {
    return { status: "error", message: ACCEPT_APPROVED_MESSAGE };
  }

  const stripe = deps.stripe ?? getConnectedStripe(await decryptToken(env, input.connectionAccessToken));
  const closed = await closeDisputeWithClient(stripe, input.stripeDisputeId, stripeCloseIdempotencyKey(input.disputeId));
  if (!closed.ok) {
    return closed.refused
      ? { status: "error", message: `Stripe did not accept the dispute: ${closed.error}` }
      : { status: "error", message: ACCEPT_UNKNOWN_MESSAGE };
  }

  try {
    await executeMoneyWrite(env, {
      accountId: input.accountId,
      idempotencyKey: acceptIdempotencyKey(input.disputeId),
      build: (db) => buildDisputeAcceptBatch(db, input),
    });
  } catch (err) {
    console.error("dispute accept write failed after Stripe closed it", err);
    return {
      status: "error",
      message:
        "Stripe accepted the dispute, but Foxhound could not record it yet. It will show as lost when Stripe sends the closing event.",
    };
  }
  return { status: "accepted" };
}
