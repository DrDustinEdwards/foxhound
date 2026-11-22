import type { Db } from "~/db";
import { recoverySteps } from "~/db";
import type { PlannedRecoveryStep } from "~/lib/recovery/schedule";

// Recovery intake: turn a detected failed payment into the scheduled sequence. planRecoverySteps (pure,
// schedule.ts) decides the steps; this inserts the operational recovery_steps rows (plain db.batch, not the
// money DO), linked to the failed_payments row the webhook wrote. The webhook owns dedup on the Stripe
// event id, so a caller must not invoke intake twice for one failed payment.

/** Build the recovery_steps inserts for a planned sequence; extracted so the batch is compile-testable without D1. */
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
