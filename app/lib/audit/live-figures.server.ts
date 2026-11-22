import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { disputes } from "~/db";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { computeDisputeStats, submittedByFoxhound } from "~/lib/disputes/stats";

// EACH FROM FOXHOUND'S OWN COMPUTATION, never a second one: active sequences
// and the lifetime recovery rate are getRecoveryStats's, the numbers the
// console and the Recovery dashboard show; the win rate is
// computeDisputeStats's, over the disputes Foxhound submitted.

export interface SavedRunLiveFigures {
  activeSequences: number;
  /** Lifetime recovered over failed, or null with no failures yet. */
  recoveryRatePct: number | null;
  /**
   * Won over resolved among disputes Foxhound submitted, or null with none
   * resolved.
   */
  foxhoundWinRate: number | null;
}

export async function readSavedRunLiveFigures(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<SavedRunLiveFigures> {
  const [stats, disputeRows] = await Promise.all([
    getRecoveryStats(db, accountId, nowMs),
    db
      .select({
        state: disputes.state,
        amountCents: disputes.amountCents,
        currency: disputes.currency,
        submittedAt: disputes.submittedAt,
        submittedBy: disputes.submittedBy,
      })
      .from(disputes)
      .where(eq(disputes.accountId, accountId)),
  ]);

  const foxhoundSubmitted = disputeRows.filter(submittedByFoxhound);

  return {
    activeSequences: stats.activeFailedCount,
    recoveryRatePct: stats.recoveryRatePct,
    foxhoundWinRate: computeDisputeStats(foxhoundSubmitted).winRatePct,
  };
}
