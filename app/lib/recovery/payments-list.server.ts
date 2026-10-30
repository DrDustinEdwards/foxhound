import { groupSumByCurrency } from "~/lib/money/totals";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import { sequenceStepLabel } from "~/lib/recovery/sequence-performance";

import type { PaymentsHeaderStats } from "./payments-list";

// /recovery/payments: the loader's own arithmetic.

/**
 * Recova's head figures (PaymentsClient.tsx filteredStats): at risk is the
 * active rows' amounts, recovered the recovered rows', and the rate recovered
 * rows over all rows, each over the rows on screen. Totals go through
 * groupSumByCurrency, so two currencies are never added.
 */
export function paymentHeaderStats(
  rows: readonly { status: string; amountCents: number; currency: string }[],
): PaymentsHeaderStats {
  const active = rows.filter((r) => r.status === "active");
  const recovered = rows.filter((r) => r.status === "recovered");
  return {
    atRisk: groupSumByCurrency(active.map((r) => ({ currency: r.currency, cents: r.amountCents }))),
    recovered: groupSumByCurrency(recovered.map((r) => ({ currency: r.currency, cents: r.amountCents }))),
    ratePct: rows.length > 0 ? Math.round((recovered.length / rows.length) * 100) : 0,
  };
}

/**
 * A step's name in Recova's words, read from the payment's own category
 * schedule. Recova's getStepLabel (lib/ui-display.ts 35c4d676) says "Day 2
 * retry" and "4hr retry"; a retry_dayN keeps Recova's day form only when its
 * offset here is exactly N days (soft's retry_day2 at 48 hours, retry_day21 at
 * 504), and is named by its hours otherwise, because network's retry_day2 runs
 * at 24 hours and "Day 2" would be false. Every other step is named as the
 * sequence page names it.
 */
export function paymentStepLabel(declineCategory: string, stepType: string): string {
  const schedule = (RECOVERY_SCHEDULES as Record<string, { stepType: string; offsetHours: number }[]>)[declineCategory];
  const offset = schedule?.find((s) => s.stepType === stepType)?.offsetHours ?? null;
  const day = /^retry_day(\d+)$/.exec(stepType);
  if (day && offset !== null && offset === Number(day[1]) * 24) return `Day ${day[1]} retry`;
  if (isRetryStep(stepType) && offset !== null) return `${offset}hr retry`;
  return sequenceStepLabel(stepType, offset);
}
