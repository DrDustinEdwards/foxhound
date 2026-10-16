import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { disputes } from "~/db";
import { getRecoveryStats } from "~/lib/dashboard/stats.server";
import { SUBMITTED_EXTERNALLY } from "~/lib/disputes/labels";
import { computeDisputeStats } from "~/lib/disputes/stats";

// The three live figures Recova's saved-run page reads beside the stored run
// (app/audit/results/[id]/page.tsx, blob a0dbf6ef, UI-GAP-05, UI-GAP-06 and
// MISSING-07): how the account is doing NOW, not when the run was taken. J63,
// row U4.
//
// EACH FROM FOXHOUND'S OWN COMPUTATION, never a second one (RULES.md 3.20):
// active sequences and the lifetime recovery rate are getRecoveryStats's, the
// numbers the console and the Recovery dashboard show; the win rate is
// computeDisputeStats's, over the disputes Foxhound submitted. Recova's own
// win rate reads `submitted_by IN ('recova','recova_auto')` and divides by
// every submission, resolved or not; Foxhound's submitted_by is the approver,
// so "Foxhound submitted" is a submission Stripe accepted that nobody else
// sent (stats.ts), and the rate is won over resolved, so an open dispute is
// not counted as a loss.
//
// Every query takes the account as its first filter (RULES.md 4.6).

export interface SavedRunLiveFigures {
  activeSequences: number;
  /** Lifetime recovered over failed, or null with no failures yet. */
  recoveryRatePct: number | null;
  /** Won over resolved among disputes Foxhound submitted, or null with none resolved. */
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

  const foxhoundSubmitted = disputeRows.filter(
    (row) => row.submittedAt !== null && row.submittedBy !== SUBMITTED_EXTERNALLY,
  );

  return {
    activeSequences: stats.activeFailedCount,
    recoveryRatePct: stats.recoveryRatePct,
    foxhoundWinRate: computeDisputeStats(foxhoundSubmitted).winRatePct,
  };
}
