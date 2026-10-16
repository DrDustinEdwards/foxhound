import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { customerContext, failedPayments, recoverySteps } from "~/db";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { isEmailStep } from "~/lib/recovery/schedule";

// "What Foxhound found" on /disputes/:id (J77, row S14): the parts of Recova's
// DisputeEvidenceSummary (blob 96ba82d4) that read something Foxhound writes
// (RULES.md 3.18). Recova read three sources for the disputed customer, and each
// is read here from Foxhound's own writer of the same fact:
//
// - Dispute history: Recova's customer_context.dispute_signals won and lost
//   counters. Foxhound's Intelligence sync writes the same two counters
//   (buildDisputeSignals, app/lib/intelligence/signals.ts).
// - Fraud decline on record: Recova's recovery_signals.fraud_decline_flag, set
//   when the recovery engine classed one of the customer's payments as fraud.
//   Foxhound stores that class on the failed payment itself
//   (failed_payments.decline_category), so the flag is read from there.
// - Recovery context and Recovery email history: Recova's most recent
//   failed_payment for the customer with its recovery_steps (page.tsx a9452f59),
//   and the recovery emails it sent. Foxhound has both tables.
//
// Every query takes the account first and scopes on it (RULES.md 4.6). Nothing
// here writes.

export interface DisputeRecoveryEmail {
  id: string;
  label: string;
  executedAt: Date;
  /** Opens counted by Foxhound's engagement recorder; null when never counted. */
  openedCount: number | null;
}

export interface DisputeFindings {
  /** Lifetime won and lost disputes for this customer; null when both are zero
   *  or the customer has no Intelligence row. */
  disputeHistory: { won: number; lost: number } | null;
  /** The customer's most recent fraud-class decline, or null when none. */
  fraudDecline: { code: string | null } | null;
  /** The customer's most recent failed payment and what recovery did. */
  recovery: {
    declineCategory: string;
    status: string;
    stepsAttempted: number;
    emails: DisputeRecoveryEmail[];
  } | null;
}

const NONE: DisputeFindings = { disputeHistory: null, fraudDecline: null, recovery: null };

function counter(signals: unknown, key: string): number {
  if (!signals || typeof signals !== "object") return 0;
  const n = Number((signals as Record<string, unknown>)[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getDisputeFindings(
  db: Db,
  accountId: string,
  stripeCustomerId: string | null,
): Promise<DisputeFindings> {
  if (!stripeCustomerId) return NONE;

  const live = and(
    eq(failedPayments.accountId, accountId),
    eq(failedPayments.stripeCustomerId, stripeCustomerId),
    isNull(failedPayments.deletedAt),
  );

  const [contextRows, fraudRows, latestRows] = await Promise.all([
    db
      .select({ disputeSignals: customerContext.disputeSignals })
      .from(customerContext)
      .where(and(eq(customerContext.accountId, accountId), eq(customerContext.stripeCustomerId, stripeCustomerId)))
      .limit(1),
    db
      .select({ declineCode: failedPayments.declineCode })
      .from(failedPayments)
      .where(and(live, eq(failedPayments.declineCategory, "fraud")))
      .orderBy(desc(failedPayments.detectedAt))
      .limit(1),
    db
      .select({
        id: failedPayments.id,
        declineCategory: failedPayments.declineCategory,
        status: failedPayments.status,
      })
      .from(failedPayments)
      .where(live)
      .orderBy(desc(failedPayments.detectedAt))
      .limit(1),
  ]);

  const signals = contextRows[0]?.disputeSignals;
  const won = counter(signals, "wonCount");
  const lost = counter(signals, "lostCount");

  const latest = latestRows[0];
  let recovery: DisputeFindings["recovery"] = null;
  if (latest) {
    const steps = await db
      .select({
        id: recoverySteps.id,
        stepType: recoverySteps.stepType,
        executedAt: recoverySteps.executedAt,
        emailOpenedCount: recoverySteps.emailOpenedCount,
      })
      .from(recoverySteps)
      .where(
        and(
          eq(recoverySteps.accountId, accountId),
          eq(recoverySteps.failedPaymentId, latest.id),
          isNull(recoverySteps.deletedAt),
        ),
      );
    const executed = steps.filter((s): s is typeof s & { executedAt: Date } => s.executedAt !== null);
    recovery = {
      declineCategory: latest.declineCategory,
      status: latest.status,
      // Recova counted every step row under "Steps attempted", scheduled ones
      // too. Only an executed step was attempted, so only those are counted.
      stepsAttempted: executed.length,
      emails: executed
        .filter((s) => isEmailStep(s.stepType))
        .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime())
        .map((s) => ({
          id: s.id,
          label: paymentStepLabel(latest.declineCategory, s.stepType),
          executedAt: s.executedAt,
          openedCount: s.emailOpenedCount,
        })),
    };
  }

  return {
    disputeHistory: won > 0 || lost > 0 ? { won, lost } : null,
    fraudDecline: fraudRows[0] ? { code: fraudRows[0].declineCode } : null,
    recovery,
  };
}
