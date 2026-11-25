import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputes, outcomes } from "~/db";
import type { DisputeState } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import { buildDisputeResolutionUpdate } from "~/lib/webhooks/batches";

import { canApproveDispute } from "./approval";

// ONE MONEY BATCH through the per-account Durable Object, keyed on the dispute:
// the resolution and its outcome row commit together or not at all, and a
// second Accept of the same dispute is a no-op.
//
// A STRIPE FAILURE WRITES NOTHING, AND ONLY STRIPE'S OWN "NO" IS CALLED ONE.
// Here only a 4xx answer (Stripe read the request and refused it) says "Stripe
// did not accept the dispute".

export type AcceptDisputeResult = { status: "accepted" } | { status: "error"; message: string };

export interface AcceptDisputeInput {
  accountId: string;
  disputeId: string;
  stripeDisputeId: string;
  state: string;
  amountCents: number;
  currency: string;
  connectionAccessToken: string;
  acceptedAt: Date;
  /** A dispute_approvals row exists for the dispute (read with the state). */
  hasApproval: boolean;
}

const ACCEPT_CLOSED_MESSAGE =
  "This dispute is already closed or submitted, so it cannot be accepted.";
export const ACCEPT_APPROVED_MESSAGE =
  "This dispute's evidence has been approved for submission, so it cannot be accepted here.";
// STRIPE REPLAYS ITS ANSWER. The close carries a stable key
// (stripeCloseIdempotencyKey), and Stripe returns the stored result of a keyed
// request for 24 hours, a 500 included (no result is stored for a 409, a 429, a
// validation failure or a request that never arrived).
const ACCEPT_UNKNOWN_MESSAGE =
  "Something went wrong while accepting. Stripe may or may not have closed this dispute, so check it in Stripe before trying again. If Stripe returned a server error, trying again here within 24 hours gets the same answer.";

function stripeCloseIdempotencyKey(disputeId: string): string {
  return `dispute-accept:${disputeId}`;
}

const DISPUTE_ACCEPTED_EVENT = "dispute_accepted";
const DISPUTE_ACCEPTED_OUTCOME = "accepted";

function acceptIdempotencyKey(disputeId: string): string {
  return `dispute-accepted:${disputeId}`;
}

function buildDisputeAcceptBatch(
  db: Db,
  input: Pick<
    AcceptDisputeInput,
    "accountId" | "disputeId" | "stripeDisputeId" | "amountCents" | "currency" | "acceptedAt"
  >,
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
          eventData: sql<string>`${JSON.stringify({ dispute_id: input.stripeDisputeId })}`.as(
            "event_data",
          ),
          outcome: sql<string>`${DISPUTE_ACCEPTED_OUTCOME}`.as("outcome"),
          outcomeAt: sql<number>`${input.acceptedAt.getTime()}`.as("outcome_at"),
          createdAt: sql<number>`${input.acceptedAt.getTime()}`.as("created_at"),
          idempotencyKey: sql<string>`${key}`.as("idempotency_key"),
          attributionKind: sql<null>`null`.as("attribution_kind"),
          attributedRef: sql<null>`null`.as("attributed_ref"),
        })
        .from(disputes)
        .where(
          and(
            eq(disputes.id, input.disputeId),
            eq(disputes.accountId, input.accountId),
            // Joined to the resolution UPDATE above (hard rule 3): only a
            // dispute that statement just resolved as lost, at this moment,
            // records "accepted". One already resolved records nothing.
            eq(disputes.state, "resolved_lost"),
            eq(disputes.resolvedAt, input.acceptedAt),
          ),
        ),
    ),
  ];
}

/**
 * Stripe answered and refused: a 4xx other than a concurrent idempotent request
 * (409) or a rate limit (429), neither of which says what happened.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429
  );
}

type CloseResult =
  | { ok: true }
  | { ok: false; refused: true; error: string }
  | { ok: false; refused: false };

async function closeDisputeWithClient(
  stripe: Stripe,
  stripeDisputeId: string,
  idempotencyKey: string,
): Promise<CloseResult> {
  try {
    await stripe.disputes.close(stripeDisputeId, {}, { idempotencyKey });
    return { ok: true };
  } catch (error) {
    if (isDefiniteRefusal(error)) {
      return {
        ok: false,
        refused: true,
        error: error instanceof Error ? error.message : "Stripe refused the request",
      };
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
  if (!canApproveDispute(input.state as DisputeState)) {
    return { status: "error", message: ACCEPT_CLOSED_MESSAGE };
  }
  if (input.hasApproval) {
    return { status: "error", message: ACCEPT_APPROVED_MESSAGE };
  }

  const stripe =
    deps.stripe ?? getConnectedStripe(await decryptToken(env, input.connectionAccessToken));
  const closed = await closeDisputeWithClient(
    stripe,
    input.stripeDisputeId,
    stripeCloseIdempotencyKey(input.disputeId),
  );
  if (!closed.ok) {
    return closed.refused
      ? {
          status: "error",
          message: `Stripe did not accept the dispute: ${closed.error}`,
        }
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
