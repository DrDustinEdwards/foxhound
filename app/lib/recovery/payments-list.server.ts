import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import { sequenceStepLabel } from "~/lib/recovery/sequence-performance";

// /recovery/payments: the loader's own arithmetic.

/** Every other step is named as the sequence page names it. */
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
