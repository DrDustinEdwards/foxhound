import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { getDb, winBackSequences } from "~/db";
import { DAY_MS } from "~/lib/constants";
import { recordOutcome } from "~/lib/engine/outcomes";

import { WINBACK_STATUS } from "./winback";

// THE WIN-BACK REACTIVATION, ported from legacy's win-back attribution block in
// handlePaymentSucceeded (app/api/webhooks/stripe/route.ts, blob `deb585e4`,
// lines 560 to 615).
//
// TWO THINGS ARE LEGACY'S AND ONE IS NOT.
//
// LEGACY'S: the transition is a CLAIM, conditional on the prior status, so a
// replayed event flips zero rows and records no second outcome; and the outcome
// is `winback_reactivated`, product recovery, carrying the sequence's amount and
// the days since cancellation.
//
// NOT LEGACY'S: the MATCH. Legacy selects on
// (account_id, stripe_customer_id, status='active') and compares no
// subscription at all, so an ordinary renewal of a DIFFERENT subscription the
// same customer still holds is credited as a win-back. 344 binding 1 rules that
// a legacy defect and matches on the sequence id carried in the Checkout
// Session's metadata instead. Class (c).
//
// IT IS NOT A MONEY WRITE. 343 binding 3 puts the flip on the PLAIN batch path
// (333's class): an account-state write is not outcome recording, billing or a
// webhook claim, and it runs after and independent of the recovery branch's
// money write, never inside it. No `recovered_payments` row is written and no
// attribution signal is recorded, because a win-back is not a Foxhound
// recovery under PRICING rev 3 (343 binding 1).

/** The statuses a reactivation may claim FROM. `exhausted` is included because
 *  step 3's own send flips the sequence terminal, so the customer who acts on
 *  the last email arrives with the sequence already exhausted (344 binding 4). */
export const WINBACK_REACTIVATABLE_STATUSES: readonly string[] = [
  WINBACK_STATUS.ACTIVE,
  WINBACK_STATUS.EXHAUSTED,
];

export interface WinbackSequenceForReactivation {
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

/**
 * THE CLAIM. Conditional on the sequence still being reactivatable AND on
 * `reactivated_at` still being NULL, so a second delivery of either event
 * affects zero rows. Legacy's is `.eq('status','active')` plus a
 * `.is('reactivated_at', null)` on the read; both conditions are on the UPDATE
 * here, which is the stronger placement (340 binding 1).
 *
 * Returns whether this call took the claim.
 */
export async function claimWinbackReactivation(
  db: Db,
  sequenceId: string,
  now: Date,
): Promise<boolean> {
  await db
    .update(winBackSequences)
    .set({ status: WINBACK_STATUS.REACTIVATED, reactivatedAt: now, resolvedAt: now })
    .where(
      and(
        eq(winBackSequences.id, sequenceId),
        inArray(winBackSequences.status, WINBACK_REACTIVATABLE_STATUSES),
        isNull(winBackSequences.reactivatedAt),
      ),
    );
  const rows = await db
    .select({ reactivatedAt: winBackSequences.reactivatedAt })
    .from(winBackSequences)
    .where(eq(winBackSequences.id, sequenceId))
    .limit(1);
  return rows[0]?.reactivatedAt?.getTime() === now.getTime();
}

/** Legacy's `days_since_cancel`: whole days between the sequence's creation and
 *  the reactivation. */
export function daysSinceCancel(createdAt: Date, now: Date): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
}

export type ReactivationOutcome =
  | { status: "reactivated"; sequenceId: string }
  | { status: "not_found" }
  | { status: "already_handled"; sequenceId: string }
  | { status: "duplicate"; sequenceId: string };

/**
 * Reactivate the named sequence, recording legacy's outcome only when the claim
 * was taken.
 *
 * A DISCRIMINATED OUTCOME, never null (339 binding 5): a deliberate refusal and
 * a swallowed failure must not look alike.
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
