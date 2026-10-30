import type { Db } from "~/db";
import { recoverySteps } from "~/db";
import type { PlannedRecoveryStep } from "~/lib/recovery/schedule";

// Recovery intake: turn a detected failed payment into the scheduled recovery
// sequence. planRecoverySteps (pure, schedule.ts) decides the steps; this inserts
// the recovery_steps rows. These are OPERATIONAL rows (scheduling state), not
// money rows, so they ride a plain per-request db.batch() rather than the
// money-write DO. The failed_payments row itself is written by the
// invoice.payment_failed webhook; intake links steps to that row's id.
//
// Idempotency: the webhook that calls intake owns dedup on the Stripe event id
// (SCHEMA.md failed_payments), so intake does not re-check; a caller must not
// invoke it twice for the same failed payment.

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

