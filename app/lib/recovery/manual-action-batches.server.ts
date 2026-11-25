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

export interface SaveNoteInput {
  accountId: string;
  failedPaymentId: string;
  note: string;
}

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

const RESEND_STEP_TYPE = "email_resend";

/**
 * The resend key's repeat token, chosen. The unit of identity here is the SEND EVENT, not the
 * submission and not the payment. This is also why the token is NOT derived from the submit:
 * because the send precedes the persist, a double-click produces TWO real sends, and collapsing
 * their rows would hide mail that actually reached the customer.
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
 * Schema-legal without a migration: `step_number` is a nullable integer and `step_type` and
 * `result` are free text with no CHECK, verified against the committed migrations.
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
 * Mark as recovered, as ONE atomic batch through the per-account money-write DO. ENTERS THROUGH THE
 * SPINE'S OWN RECORDER. "No second writer of recovered_payments" is satisfied by one BUILDER, and
 * the fee row and the moat row stay a single atomic pair rather than drifting apart. NEVER
 * BILLABLE: the attribution kind is `manual`, which is absent from BILLABLE_ATTRIBUTION_KINDS, so
 * `buildRecoveryBatch` stamps `attributed_at` NULL and every billing predicate skips the row while
 * the moat keeps it.
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
 * Stop recovery, as ONE atomic batch: the payment goes terminal and every unexecuted step is
 * canceled together, or neither happens. That is what keeps "do not cancel steps when the claim
 * loses" true without branching, which a single atomic batch cannot do. Step cancellation is what
 * actually stops the engine: `stepDueCondition` requires `result IS NULL`, so a canceled step is
 * never selected again.
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
