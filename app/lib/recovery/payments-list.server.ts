import { groupSumByCurrency } from "~/lib/dashboard/stats.server";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import { sequenceStepLabel } from "~/lib/recovery/sequence-performance";

import type { PaymentsHeaderStats } from "./payments-list";

// /recovery/payments (row S6, job J75): the loader's own arithmetic.

/**
 * Recova's head figures (PaymentsClient.tsx filteredStats): at risk is the
 * active rows' amounts, recovered the recovered rows', and the rate recovered
 * rows over all rows, each over the rows on screen. Totals go through
 * groupSumByCurrency (RULES.md 3.20), so two currencies are never added.
 */
export function paymentHeaderStats(
  rows: readonly { status: string; amountCents: number; currency: string }[],
): PaymentsHeaderStats {
  const active = rows.filter((r) => r.status === "active");
  const recovered = rows.filter((r) => r.status === "recovered");
  return {
    atRisk: groupSumByCurrency(active),
    recovered: groupSumByCurrency(recovered),
    ratePct: rows.length > 0 ? Math.round((recovered.length / rows.length) * 100) : 0,
  };
}

/**
 * A step's name in Recova's words ("Day 3 email", "4hr retry"), read from the
 * payment's own category schedule so a retry is named by its real offset.
 */
export function paymentStepLabel(declineCategory: string, stepType: string): string {
  const schedule = (RECOVERY_SCHEDULES as Record<string, { stepType: string; offsetHours: number }[]>)[declineCategory];
  const offset = schedule?.find((s) => s.stepType === stepType)?.offsetHours ?? null;
  return sequenceStepLabel(stepType, offset);
}
