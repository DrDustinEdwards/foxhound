// The money-write batches behind the manual payment-detail actions
// (manual-actions.server.ts): note, resend, mark recovered and stop recovery.
// Pure builders; the dispatcher commits each through the money-write DO.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { MoneyWriteBatch } from "~/db/money-write";
import { type Db, failedPayments, recoverySteps } from "~/db";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_CANCELLED,
  MANUAL_ATTRIBUTION_KIND,
} from "~/lib/constants";
import { buildRecoveryBatch } from "./record-recovery";

/**
 * The note key's repeat token: a digest of the note's CONTENT.
 *
 * This is the shape the brief asks for and the reason is worth stating. A key
 * fixed per payment would collapse every later edit into a no-op, so the second
 * thing a merchant ever typed would be silently discarded. A key varying per
 * request would make a retried submission write twice, which for this update is
 * harmless but defeats the point of having a key at all. Keying on the content
 * gives both: re-submitting the SAME text is a true no-op, and changing one
 * character is a new key that applies.
 */
export async function noteContentToken(note: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(note));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Atomic batches. Exported pure so each is unit-tested against the real schema.
// ---------------------------------------------------------------------------

export interface SaveNoteInput {
  accountId: string;
  failedPaymentId: string;
  /** Raw textarea value. Empty string becomes NULL, exactly as legacy does. */
  note: string;
}

/** Legacy's note contract, one statement (app/api/payments/[id]/note/route.ts):
 *  `.update({ notes: note || null }).eq('id', id).eq('account_id', ...)`. The
 *  `|| null` is legacy's, so a cleared textarea clears the column rather than
 *  storing an empty string; whitespace-only text is preserved, also as legacy. */
export function buildSaveNoteBatch(db: Db, input: SaveNoteInput): MoneyWriteBatch {
  return [
    db
      .update(failedPayments)
      .set({ notes: input.note || null })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
        ),
      ),
  ];
}

/** email_sends.template label for a merchant-initiated resend. Distinct from the
 *  engine's own labels so "how much mail was resent by hand" is one WHERE clause. */
export const TEMPLATE_LABEL_RESEND = "recovery_resend";

/** The step_type legacy writes for a resend, so the timeline shows it as its own
 *  event rather than mutating the original send's row. */
export const RESEND_STEP_TYPE = "email_resend";

/**
 * The resend key's repeat token, chosen under 265's key-design reasoning.
 *
 * The unit of identity here is the SEND EVENT, not the submission and not the
 * payment. A per-payment key would collapse every later resend into the first,
 * silently discarding deliberate ones. A per-request key would collapse nothing.
 * Keying on the provider's own message id collapses exactly the case worth
 * collapsing, a retried PERSIST of a send that already happened, while a
 * genuinely new send carries a new id and applies.
 *
 * This is also why the token is NOT derived from the submit: because the send
 * precedes the persist (268), a double-click produces TWO real sends, and
 * collapsing their rows would hide mail that actually reached the customer. The
 * row should record what happened, not what was clicked.
 *
 * The fallback, when the provider returns no id, is step plus timestamp: it
 * cannot collapse, which errs toward recording a send twice rather than losing
 * one. Under-recording a send is the worse failure on a compliance surface.
 */
export function resendRepeatToken(
  providerMessageId: string | null,
  stepId: string,
  now: Date,
): string {
  return providerMessageId ?? `${stepId}:${now.getTime()}`;
}

export interface ResendStepInput {
  accountId: string;
  failedPaymentId: string;
  subject: string;
  bodyHtml: string;
  providerMessageId: string | null;
  now: Date;
}

/**
 * Legacy's resend timeline row, one statement (its route's own insert): a NEW
 * recovery_steps row with step_type `email_resend`, `step_number` null, executed
 * now, carrying the resent copy and the provider's send id.
 *
 * Schema-legal without a migration: `step_number` is a nullable integer and
 * `step_type` and `result` are free text with no CHECK, verified against the
 * committed migrations. `result` is `email_sent`, matching what the engine writes
 * for a delivered send, so the timeline renders it with the existing tone map
 * rather than needing a new vocabulary entry.
 *
 * THE PROVIDER ID IS NOT ON THIS ROW, and that is a deliberate internal
 * difference. Legacy carries a `resend_message_id` column on its step;
 * recovery_steps has no such column and does not need one, because
 * processEmailJob already logged this send to `email_sends` with its
 * `provider_message_id`, its template label and its recipient hash. Duplicating
 * it here would create a second home for the same fact. Class (a): invisible to
 * the merchant, who sees the timeline row either way.
 *
 * NO fee row and NO outcome row, which is legacy's own shape: a resend is
 * outreach, not a recovery, and nothing about it is billable.
 */
export function buildResendStepBatch(db: Db, input: ResendStepInput): MoneyWriteBatch {
  return [
    db.insert(recoverySteps).values({
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      stepType: RESEND_STEP_TYPE,
      stepNumber: null,
      scheduledAt: input.now,
      executedAt: input.now,
      result: "email_sent",
      aiSubject: input.subject,
      aiBodyHtml: input.bodyHtml,
    }),
  ];
}

export interface MarkRecoveredInput {
  accountId: string;
  failedPaymentId: string;
  amountCents: number;
  currency: string;
  now: Date;
}

/**
 * Mark as recovered, as ONE atomic batch through the per-account money-write DO.
 *
 * ENTERS THROUGH THE SPINE'S OWN RECORDER (262 decision five). Statement two is
 * `buildRecoveryBatch`, the exact builder the invoice.payment_succeeded webhook
 * uses, not a parallel insert. "No second writer of recovered_payments" is
 * satisfied by one BUILDER, and the fee row and the moat row stay a single
 * atomic pair rather than drifting apart.
 *
 * THE IDEMPOTENCY GUARD IS INHERITED, NOT INVENTED, and this is why no unique
 * index was added to recovered_payments. `buildRecoveryBatch` derives its
 * outcomes key from its `idempotencyKey` input, and the webhook passes the
 * FAILED PAYMENT ID (webhooks/batches.ts). Passing the same here puts both
 * callers in one key space, `recovery:<failedPaymentId>`, guarded by the real
 * partial unique index `outcomes_idempotency_uq`. Whichever commits second rolls
 * the whole batch back, fee row included. A unique index on
 * recovered_payments.failed_payment_id would be a second mechanism for a
 * guarantee that already holds, bought with a UNIQUE migration on a fee-bearing
 * table that fails to apply if any duplicate already exists.
 *
 * THE CLAIM SHAPE is legacy's own and the one 265 ratified for cancel: the
 * status UPDATE carries `status = 'active'`, so it CLAIMS the transition rather
 * than asserting it. Legacy's recover route explains why in its own comment: the
 * webhook can resolve the payment between the read and the write.
 *
 * NEVER BILLABLE (262 decision one): the attribution kind is `manual`, which is
 * absent from BILLABLE_ATTRIBUTION_KINDS, so `buildRecoveryBatch` stamps
 * `attributed_at` NULL and every billing predicate skips the row while the moat
 * keeps it.
 *
 * STEP THREE is legacy's, read from source rather than assumed symmetric with
 * cancel: recover also resolves the unexecuted steps to `cancelled`. It is
 * conditioned on the claim having landed, through a correlated subquery reading
 * statement one's effect inside the same transaction, so a lost race cancels
 * nothing. Foxhound also scopes it by account, which legacy's does not.
 */
export function buildMarkRecoveredBatch(db: Db, input: MarkRecoveredInput): MoneyWriteBatch {
  const paymentIsRecovered = sql`exists (select 1 from ${failedPayments} where ${failedPayments.id} = ${input.failedPaymentId} and ${failedPayments.accountId} = ${input.accountId} and ${failedPayments.status} = ${"recovered"})`;
  return [
    db
      .update(failedPayments)
      .set({ status: "recovered", resolvedAt: input.now })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      ),
    ...buildRecoveryBatch(db, {
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      amountCents: input.amountCents,
      currency: input.currency,
      recoveredAt: input.now,
      attribution: { kind: MANUAL_ATTRIBUTION_KIND, ref: null },
      recoveredByStepId: null,
      recoveryMethod: MANUAL_ATTRIBUTION_KIND,
      idempotencyKey: input.failedPaymentId,
    }),
    db
      .update(recoverySteps)
      .set({ result: "cancelled" })
      .where(
        and(
          eq(recoverySteps.failedPaymentId, input.failedPaymentId),
          eq(recoverySteps.accountId, input.accountId),
          isNull(recoverySteps.executedAt),
          paymentIsRecovered,
        ),
      ),
  ];
}

export interface StopRecoveryInput {
  accountId: string;
  failedPaymentId: string;
  now: Date;
}

/**
 * Stop recovery, as ONE atomic batch: the payment goes terminal and every
 * unexecuted step is canceled together, or neither happens.
 *
 * TWO GUARDS, and the first is a deliberate hardening over legacy.
 *
 * (1) The status UPDATE carries `status = 'active'` in its WHERE, so it CLAIMS
 * the active-to-canceled transition rather than asserting it. Legacy's cancel
 * route does NOT do this; it fires an unconditional `Promise.all` and discards
 * both results, which was safe for legacy only because nothing bills on cancel.
 * Legacy's own RECOVER route uses exactly this claim shape and explains why: a
 * concurrent writer can resolve the payment between the read and the write. That
 * window is real here too, and a terminal overwrite inside it would assert a
 * FALSE state, recording a merchant-stopped sequence over a payment that had
 * actually been recovered. Ruling 262 decision four routes this through the DO
 * precisely to kill such races; the claim is the same intent expressed in SQL.
 *
 * (2) The steps UPDATE is conditioned on the payment ACTUALLY being canceled
 * now, via a correlated subquery. Statements in a batch run in order inside one
 * transaction, so this reads statement (1)'s effect: if the claim took zero rows
 * because something else resolved the payment first, the subquery is false and
 * no step is touched. That is what keeps "do not cancel steps when the claim
 * loses" true without branching, which a single atomic batch cannot do.
 *
 * Step cancellation is what actually stops the engine: `stepDueCondition`
 * requires `result IS NULL`, so a canceled step is never selected again. The
 * exhausted-sequence sweep is separately safe, since it gates on status
 * 'active' and a canceled payment no longer matches.
 */
export function buildStopRecoveryBatch(db: Db, input: StopRecoveryInput): MoneyWriteBatch {
  const paymentIsCancelled = sql`exists (select 1 from ${failedPayments} where ${failedPayments.id} = ${input.failedPaymentId} and ${failedPayments.accountId} = ${input.accountId} and ${failedPayments.status} = ${FAILED_PAYMENT_STATUS_CANCELLED})`;
  return [
    db
      .update(failedPayments)
      .set({ status: FAILED_PAYMENT_STATUS_CANCELLED, resolvedAt: input.now })
      .where(
        and(
          eq(failedPayments.id, input.failedPaymentId),
          eq(failedPayments.accountId, input.accountId),
          eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        ),
      ),
    db
      .update(recoverySteps)
      .set({ result: FAILED_PAYMENT_STATUS_CANCELLED })
      .where(
        and(
          eq(recoverySteps.failedPaymentId, input.failedPaymentId),
          eq(recoverySteps.accountId, input.accountId),
          isNull(recoverySteps.executedAt),
          paymentIsCancelled,
        ),
      ),
  ];
}
