import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, winBackSequences } from "~/db";
import { DAY_MS } from "~/lib/constants";
import { recordOutcome } from "~/lib/engine/outcomes";

import { WINBACK_STATUS } from "./winback";

// Class (c).

/** The statuses a reactivation may claim FROM. `exhausted` is included because
 *  step 3's own send flips the sequence terminal, so the customer who acts on
 *  the last email arrives with the sequence already exhausted. */
export const WINBACK_REACTIVATABLE_STATUSES: readonly string[] = [
  WINBACK_STATUS.ACTIVE,
  WINBACK_STATUS.EXHAUSTED,
];

interface WinbackSequenceForReactivation {
  id: string;
  accountId: string;
  amountCents: number | null;
  createdAt: Date;
  status: string;
}

/** Read the sequence this reactivation names, scoped to the webhook's account
 *  so a metadata value from another merchant resolves to nothing. */
async function loadReactivatableSequence(
  db: Db,
  accountId: string,
  sequenceId: string,
): Promise<WinbackSequenceForReactivation | null> {
  const rows = await db
    .select({
      id: winBackSequences.id,
      accountId: winBackSequences.accountId,
      amountCents: winBackSequences.amountCents,
      createdAt: winBackSequences.createdAt,
      status: winBackSequences.status,
    })
    .from(winBackSequences)
    .where(and(eq(winBackSequences.id, sequenceId), eq(winBackSequences.accountId, accountId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.accountId === null) return null;
  return { ...row, accountId: row.accountId };
}

/** THE CLAIM. Returns whether this call took the claim. */
async function claimWinbackReactivation(db: Db, sequenceId: string, now: Date): Promise<boolean> {
  // The UPDATE says itself whether it matched (RETURNING), so the claim never
  // rests on a re-read of reactivated_at: two deliveries in the same
  // millisecond would both read their own `now` back and both send.
  const claimed = await db
    .update(winBackSequences)
    .set({ status: WINBACK_STATUS.REACTIVATED, reactivatedAt: now, resolvedAt: now })
    .where(
      and(
        eq(winBackSequences.id, sequenceId),
        inArray(winBackSequences.status, WINBACK_REACTIVATABLE_STATUSES),
        isNull(winBackSequences.reactivatedAt),
      ),
    )
    .returning({ id: winBackSequences.id });
  return claimed.length === 1;
}

function daysSinceCancel(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
}

export type ReactivationOutcome =
  | { status: "reactivated"; sequenceId: string }
  | { status: "not_found" }
  | { status: "already_handled"; sequenceId: string }
  | { status: "duplicate"; sequenceId: string };

/**
 * A DISCRIMINATED OUTCOME, never null: a deliberate refusal and a swallowed failure must not look
 * alike.
 */
export async function reactivateWinbackSequence(
  env: Env,
  input: { accountId: string; sequenceId: string; now: Date },
): Promise<ReactivationOutcome> {
  const db = getDb(env);
  const sequence = await loadReactivatableSequence(db, input.accountId, input.sequenceId);
  if (!sequence) return { status: "not_found" };
  if (!WINBACK_REACTIVATABLE_STATUSES.includes(sequence.status)) {
    return { status: "already_handled", sequenceId: sequence.id };
  }

  const claimed = await claimWinbackReactivation(db, sequence.id, input.now);
  if (!claimed) return { status: "duplicate", sequenceId: sequence.id };

  await recordOutcome(env, {
    accountId: sequence.accountId,
    product: "recovery",
    eventType: "winback_reactivated",
    outcome: "reactivated",
    eventData: {
      amountCents: sequence.amountCents,
      daysSinceCancel: daysSinceCancel(sequence.createdAt, input.now),
    },
    idempotencyKey: `winback-reactivated:${sequence.id}`,
    outcomeAt: input.now,
  });

  return { status: "reactivated", sequenceId: sequence.id };
}
