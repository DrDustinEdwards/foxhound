import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { recoverySteps } from "~/db";

// The card_update attribution signal (SCHEMA.md spine #1): recorded on the
// hosted /p/:token page once a customer completes a payment-method update
// against the connected account. findAttributionSignals
// (app/lib/recovery/attribution.ts) reads this same shape (stepType
// "card_update", result "card_updated") when webhooks/process.ts resolves
// attribution on invoice.payment_succeeded (M1, Phase 4 review). Operational
// write, not money (recording that an update happened does not itself gate
// billing), so a plain insert, mirroring the engagement click-stamp
// precedent (gotcha #25/#37).

/** True if a card_update signal already exists for this failed payment. Read
 *  guard before inserting (fast path; a double-submit races harmlessly, this
 *  is not a money write, but avoids a duplicate row on the common case). */
export async function hasCardUpdateSignal(db: Db, failedPaymentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: recoverySteps.id })
    .from(recoverySteps)
    .where(and(eq(recoverySteps.failedPaymentId, failedPaymentId), eq(recoverySteps.stepType, "card_update")))
    .limit(1);
  return rows.length > 0;
}

export function buildCardUpdateSignal(
  db: Db,
  input: { failedPaymentId: string; accountId: string; occurredAt: Date },
) {
  return db.insert(recoverySteps).values({
    failedPaymentId: input.failedPaymentId,
    accountId: input.accountId,
    stepType: "card_update",
    scheduledAt: input.occurredAt,
    executedAt: input.occurredAt,
    result: "card_updated",
  });
}
