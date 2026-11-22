// Recovery step scheduler: pure selection of which recovery_steps row is due. At most one step runs per tick
// per payment; silent-first ordering is baked into the schedule, so "earliest due" is correct.

export interface SchedulableStep {
  stepNumber: number | null;
  scheduledAt: Date;
  executedAt: Date | null;
  result: string | null;
  nextRetryAt: Date | null;
}

function dueAt(step: SchedulableStep): number {
  return (step.nextRetryAt ?? step.scheduledAt).getTime();
}

/** True when a step is unexecuted with no terminal result and its effective due time has arrived. */
export function isStepDue(step: SchedulableStep, now: Date): boolean {
  if (step.executedAt != null || step.result != null) return false;
  return dueAt(step) <= now.getTime();
}

export function selectDueSteps<T extends SchedulableStep>(steps: T[], now: Date): T[] {
  return steps
    .filter((s) => isStepDue(s, now))
    .sort((a, b) => dueAt(a) - dueAt(b) || (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
}

export function nextDueStep<T extends SchedulableStep>(steps: T[], now: Date): T | null {
  return selectDueSteps(steps, now)[0] ?? null;
}

/** True when every step has executed to a terminal result. (A mid-sequence recovery is halted by the webhook, not here.) */
export function isSequenceComplete(steps: SchedulableStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.executedAt != null);
}
