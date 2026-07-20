import { and, eq, ne } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { outcomes, recoveredPayments } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { isBillableAttribution, type ResolvedAttribution } from "./attribution";

// Records a recovered payment WITH its attribution, through the per-account
// money-write Durable Object, as ONE atomic batch: the recovered_payments row
// (the billing denominator) + the outcomes moat row. Both attributed and
// baseline recoveries are recorded with equal fidelity; baseline is the free
// line (PRICING.md spine #2).
//
// Boundary: the invoice.payment_succeeded webhook is the SOLE recorder of a
// recovery (buildRecoverBatch in webhooks/batches.ts is the only caller of
// buildRecoveryBatch's insert) and the sole owner of the failed_payments
// 'recovered' status flip. The retry executor (execute-step.ts) never inserts
// here; it only calls reconcileRetryRecovery below, an UPDATE-only correction
// for the narrow reverse-race window (review Finding 1 + 2). Phase 4b builds
// and unit-tests the insert path.
//
// Idempotency: the outcomes row carries a stable key (outcomes_idempotency_uq),
// so a webhook redelivery makes the whole atomic batch fail the unique
// constraint and roll back - exactly-once recovery recording by construction.
// This is now safe for the status flip too (buildRecoverBatch.ts): since the
// executor never inserts, the webhook's insert is the only writer that can ever
// collide with itself (a same-event redelivery), never with a second writer.

export interface RecordRecoveryInput {
  accountId: string;
  failedPaymentId: string;
  amountCents: number;
  currency: string;
  recoveredAt: Date;
  attribution: ResolvedAttribution;
  /** The recovery_steps row credited (e.g. the succeeded retry), if any. */
  recoveredByStepId?: string | null;
  /** How the money came back: retry | email | card_update | stripe_baseline. */
  recoveryMethod: string;
  /** Stable per recovery event (e.g. the Stripe event id) so replays collapse. */
  idempotencyKey: string;
}

/** The atomic batch for a recovery recording. Extracted so it is unit-testable. */
export function buildRecoveryBatch(db: Db, input: RecordRecoveryInput): MoneyWriteBatch {
  const attributed = isBillableAttribution(input.attribution.kind);
  const key = `recovery:${input.idempotencyKey}`;
  return [
    db.insert(recoveredPayments).values({
      accountId: input.accountId,
      failedPaymentId: input.failedPaymentId,
      recoveredAt: input.recoveredAt,
      amountCents: input.amountCents,
      currency: input.currency,
      recoveryMethod: input.recoveryMethod,
      recoveredByStepId: input.recoveredByStepId ?? null,
      attributionKind: input.attribution.kind,
      attributionRef: input.attribution.ref,
      // Attributed recoveries stamp attributed_at; baseline stays null (free).
      attributedAt: attributed ? input.recoveredAt : null,
    }),
    db.insert(outcomes).values({
      accountId: input.accountId,
      product: "recovery",
      eventType: "payment_recovered",
      outcome: attributed ? "recovered_attributed" : "recovered_baseline",
      outcomeAt: input.recoveredAt,
      createdAt: input.recoveredAt,
      idempotencyKey: key,
      attributionKind: input.attribution.kind,
      attributedRef: input.attribution.ref,
      eventData: {
        amountCents: input.amountCents,
        currency: input.currency,
        method: input.recoveryMethod,
      },
    }),
  ];
}

export interface RetryReconciliationInput {
  accountId: string;
  failedPaymentId: string;
  /** The succeeded retry step, the ground-truth cause of the recovery. */
  stepId: string;
  recoveredAt: Date;
}

/**
 * The UPDATE-only correction for the reverse-race window (review Finding 1 + 2):
 * if the invoice.payment_succeeded webhook already recorded this failed payment
 * (it is the sole inserter) before this retry's step patch landed, it could not
 * yet see the succeeded retry and fell back to a lesser attribution (usually
 * stripe_baseline). This upgrades that existing row to foxhound_retry, the
 * strongest proof of causation (attribution.ts's own priority order), using the
 * step that just landed as the ref.
 *
 * Never inserts, so it can never collide with the webhook's insert: no whole-batch
 * rollback risk, the webhook's status flip is never at stake here. Idempotent by
 * construction (the WHERE excludes rows already at foxhound_retry): a no-op when
 * the webhook has not recorded anything yet (the dominant ordering - it will see
 * the persisted step result and self-attribute foxhound_retry) or already did.
 */
export function buildRetryReconciliationBatch(
  db: Db,
  input: RetryReconciliationInput,
): MoneyWriteBatch {
  const key = `recovery:${input.failedPaymentId}`;
  return [
    db
      .update(recoveredPayments)
      .set({
        attributionKind: "foxhound_retry",
        attributionRef: input.stepId,
        recoveredByStepId: input.stepId,
        recoveryMethod: "foxhound_retry",
        attributedAt: input.recoveredAt,
      })
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, input.failedPaymentId),
          ne(recoveredPayments.attributionKind, "foxhound_retry"),
        ),
      ),
    db
      .update(outcomes)
      .set({
        outcome: "recovered_attributed",
        attributionKind: "foxhound_retry",
        attributedRef: input.stepId,
      })
      .where(and(eq(outcomes.idempotencyKey, key), ne(outcomes.attributionKind, "foxhound_retry"))),
  ];
}

// A single reconcile attempt cannot see a webhook write that has not landed in
// the DB yet. Fresh-context re-review (2026-07-20) found a residual: if the
// webhook's attribution read (taken before it enters the money DO) loses to
// this reconcile at the DO, its later-landing baseline row is never corrected,
// since reconcile only runs once. invoice.payment_succeeded is delivered on the
// order of seconds after a successful charge (module header, execute-step.ts),
// so a short retry window covers the realistic delivery timing without a
// schema change or a second inserter. Each attempt is its own idempotency key
// (a fresh DO "seen" entry) so the DO fast path cannot skip a later attempt
// just because an earlier one already committed its (possibly no-op) UPDATE.
const RECONCILE_RETRY_DELAYS_MS = [0, 150, 350];

/** Reconcile a landed retry against whatever the webhook already recorded.
 *  Routed through the per-account money-write DO like every other recovery
 *  write (ARCHITECTURE.md #1), even though the UPDATE-only shape is idempotent
 *  by construction. Retries a few times with short delays (see
 *  RECONCILE_RETRY_DELAYS_MS) so a webhook that lands moments after the first
 *  attempt still gets corrected. Returns true if any attempt applied cleanly. */
export async function reconcileRetryRecovery(
  env: Env,
  input: RetryReconciliationInput,
): Promise<boolean> {
  let appliedAny = false;
  for (let attempt = 0; attempt < RECONCILE_RETRY_DELAYS_MS.length; attempt++) {
    const delayMs = RECONCILE_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const { applied } = await executeMoneyWrite(env, {
      accountId: input.accountId,
      idempotencyKey: `recovery-reconcile:${input.failedPaymentId}:${attempt}`,
      build: (db) => buildRetryReconciliationBatch(db, input),
    });
    if (applied) appliedAny = true;
  }
  return appliedAny;
}
