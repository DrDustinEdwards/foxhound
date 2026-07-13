import type { Db } from "~/db";
import { getDb, recoverySteps } from "~/db";
import type { DeclineCategory } from "~/lib/constants";
import { planRecoverySteps, type PlannedRecoveryStep } from "~/lib/recovery/schedule";

// Recovery intake: turn a detected failed payment into the scheduled recovery
// sequence. planRecoverySteps (pure, schedule.ts) decides the steps; this inserts
// the recovery_steps rows. These are OPERATIONAL rows (scheduling state), not
// money rows, so they ride a plain per-request db.batch() rather than the
// money-write DO. The failed_payments row itself is written by the
// invoice.payment_failed webhook (Phase 4c); intake links steps to that row's id.
//
// Idempotency: the webhook that calls intake owns dedup on the Stripe event id
// (SCHEMA.md failed_payments), so intake does not re-check; a caller must not
// invoke it twice for the same failed payment.

export interface IntakeInput {
  failedPaymentId: string;
  accountId: string;
  declineCategory: DeclineCategory;
  detectedAt: Date;
}

/**
 * Build the recovery_steps insert statements for a planned sequence. Extracted so
 * the batch is compile-testable (.toSQL) without a live D1, mirroring the
 * money-write compile test.
 */
export function buildRecoveryStepInserts(db: Db, planned: PlannedRecoveryStep[]) {
  return planned.map((step) =>
    db.insert(recoverySteps).values({
      failedPaymentId: step.failedPaymentId,
      accountId: step.accountId,
      stepType: step.stepType,
      stepNumber: step.stepNumber,
      scheduledAt: step.scheduledAt,
    }),
  );
}

/**
 * Plan and insert the recovery sequence for a failed payment. Returns the number
 * of steps scheduled. No-op-safe against an empty plan (never happens for a valid
 * decline category, but guarded so db.batch's non-empty contract is never broken).
 */
export async function intakeRecoverySequence(env: Env, input: IntakeInput): Promise<number> {
  const planned = planRecoverySteps({
    failedPaymentId: input.failedPaymentId,
    accountId: input.accountId,
    declineCategory: input.declineCategory,
    detectedAt: input.detectedAt,
  });
  if (planned.length === 0) return 0;

  const db = getDb(env);
  const inserts = buildRecoveryStepInserts(db, planned);
  await db.batch(inserts as [(typeof inserts)[number], ...(typeof inserts)[number][]]);
  return planned.length;
}
