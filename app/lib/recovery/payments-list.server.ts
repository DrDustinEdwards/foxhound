import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import { sequenceStepLabel } from "~/lib/recovery/sequence-performance";

// /recovery/payments: the loader's own arithmetic.

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
  const schedule = (
    RECOVERY_SCHEDULES as Record<string, { stepType: string; offsetHours: number }[]>
  )[declineCategory];
  const offset = schedule?.find((s) => s.stepType === stepType)?.offsetHours ?? null;
  const day = /^retry_day(\d+)$/.exec(stepType);
  if (day && offset !== null && offset === Number(day[1]) * 24) return `Day ${day[1]} retry`;
  if (isRetryStep(stepType) && offset !== null) return `${offset}hr retry`;
  return sequenceStepLabel(stepType, offset);
}
