// Recovery step scheduler: pure selection of which recovery_steps row is due to
// run now. The cron loads a payment's steps and asks this which one to
// execute; the engine runs at most one step per tick per payment (silent-first
// ordering is baked into the schedule, so "earliest due" is correct ordering).

/** The recovery_steps fields the scheduler reads. */
export interface SchedulableStep {
  stepNumber: number | null;
  scheduledAt: Date;
  /** Set once the step has run to a terminal result. */
  executedAt: Date | null;
  result: string | null;
  /** Set when a transient send failure rescheduled the step (step-state machine). */
  nextRetryAt: Date | null;
}

/** The effective time a step becomes runnable: its retry time if rescheduled, else its scheduled time. */
function dueAt(step: SchedulableStep): number {
  return (step.nextRetryAt ?? step.scheduledAt).getTime();
}

/**
 * True when a step is ready to run: not yet executed, no terminal result, and its
 * effective due time has arrived. A step rescheduled by the send-attempt backoff
 * stays unexecuted with next_retry_at set, so it becomes due again at that time.
 */
export function isStepDue(step: SchedulableStep, now: Date): boolean {
  if (step.executedAt != null || step.result != null) return false;
  return dueAt(step) <= now.getTime();
}

/** All due steps, earliest first (by effective due time, then step number). */
export function selectDueSteps<T extends SchedulableStep>(steps: T[], now: Date): T[] {
  return steps
    .filter((s) => isStepDue(s, now))
    .sort((a, b) => dueAt(a) - dueAt(b) || (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
}

/** The single earliest due step, or null when nothing is due. Engine runs one per tick. */
export function nextDueStep<T extends SchedulableStep>(steps: T[], now: Date): T | null {
  return selectDueSteps(steps, now)[0] ?? null;
}

/**
 * True when the whole sequence has run out: every step has executed to a terminal
 * result. (A payment that recovers mid-sequence is halted separately by the
 * invoice.payment_succeeded webhook resolving the failed_payment; that is not the
 * scheduler's concern.)
 */
export function isSequenceComplete(steps: SchedulableStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.executedAt != null);
}
