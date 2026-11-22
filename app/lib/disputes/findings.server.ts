import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { customerContext, failedPayments, recoverySteps } from "~/db";
import { paymentStepLabel } from "~/lib/recovery/payments-list.server";
import { isEmailStep } from "~/lib/recovery/schedule";

interface DisputeRecoveryEmail {
  id: string;
  label: string;
  executedAt: Date;
  /**
   * Opens counted by Foxhound's engagement recorder; null when never counted.
   */
  openedCount: number | null;
}

export interface DisputeFindings {
  /**
   * Lifetime won and lost disputes for this customer; null when both are zero
   * or the customer has no Intelligence row.
   */
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
      .where(
        and(
          eq(customerContext.accountId, accountId),
          eq(customerContext.stripeCustomerId, stripeCustomerId),
        ),
      )
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
    const executed = steps.filter(
      (s): s is typeof s & { executedAt: Date } => s.executedAt !== null,
    );
    recovery = {
      declineCategory: latest.declineCategory,
      status: latest.status,
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
