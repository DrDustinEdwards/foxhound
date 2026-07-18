// Pure progress summary for a failed payment's recovery_steps sequence, used by
// the /recovery/sequences queue view. No DB access; takes whatever rows the
// caller already fetched.

export interface SequenceStepInput {
  stepNumber: number | null;
  stepType: string;
  scheduledAt: Date;
  executedAt: Date | null;
}

export interface SequenceSummary {
  completedCount: number;
  totalCount: number;
  /** The earliest not-yet-executed step in schedule order, or null when the
   *  sequence has run every step. */
  nextStep: SequenceStepInput | null;
}

export function summarizeSequence(steps: SequenceStepInput[]): SequenceSummary {
  const sorted = [...steps].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0));
  return {
    completedCount: sorted.filter((s) => s.executedAt !== null).length,
    totalCount: sorted.length,
    nextStep: sorted.find((s) => s.executedAt === null) ?? null,
  };
}
