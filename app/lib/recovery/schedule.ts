import {
  type DeclineCategory,
  HOUR_MS,
  STEP_TIMING_EMAIL_DAY14_HOURS,
  STEP_TIMING_EMAIL_DAY1_HOURS,
  STEP_TIMING_EMAIL_DAY30_HOURS,
  STEP_TIMING_EMAIL_DAY3_HOURS,
  STEP_TIMING_EMAIL_DAY7_HOURS,
  STEP_TIMING_FRAUD_EMAIL_DAY1_HOURS,
  STEP_TIMING_NETWORK_EMAIL_DAY3_HOURS,
  STEP_TIMING_NETWORK_RETRY_DAY2_HOURS,
  STEP_TIMING_RETRY_4HR_HOURS,
  STEP_TIMING_RETRY_DAY21_HOURS,
  STEP_TIMING_RETRY_DAY2_HOURS,
  STEP_TIMING_RETRY_EARLY_HOURS,
  STEP_TIMING_REVOKED_EMAIL_HOURS,
  STEP_TIMING_SOFT_EMAIL_DAY1_HOURS,
  WINBACK_STEP1_HOURS,
  WINBACK_STEP2_HOURS,
  WINBACK_STEP3_HOURS,
} from "~/lib/constants";

// Recovery schedules: the ordered steps run after a failed payment, per decline category. Fraud
// never retries (a 21-day retry risks the issuer's fraud counter -> higher fees).

export interface ScheduledStep {
  stepType: string;
  offsetHours: number;
}

/** Step-type prefixes. A step is a silent retry iff it starts with `retry_`. */
export function isRetryStep(stepType: string): boolean {
  return stepType.startsWith("retry_");
}
export function isEmailStep(stepType: string): boolean {
  return stepType.startsWith("email_");
}

export const RECOVERY_SCHEDULES: Record<DeclineCategory, ScheduledStep[]> = {
  soft: [
    { stepType: "retry_early", offsetHours: STEP_TIMING_RETRY_EARLY_HOURS },
    { stepType: "email_day1", offsetHours: STEP_TIMING_SOFT_EMAIL_DAY1_HOURS },
    { stepType: "retry_day2", offsetHours: STEP_TIMING_RETRY_DAY2_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "retry_day21", offsetHours: STEP_TIMING_RETRY_DAY21_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
  network: [
    { stepType: "retry_4hr", offsetHours: STEP_TIMING_RETRY_4HR_HOURS },
    { stepType: "retry_day2", offsetHours: STEP_TIMING_NETWORK_RETRY_DAY2_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_NETWORK_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "retry_day21", offsetHours: STEP_TIMING_RETRY_DAY21_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
  // Expired cards re-decline on retry; recovery needs a card update, so the first step is the email
  // that carries the update link.
  expired: [
    { stepType: "email_day1", offsetHours: STEP_TIMING_EMAIL_DAY1_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "retry_day21", offsetHours: STEP_TIMING_RETRY_DAY21_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
  // Fraud never retries (issuer fraud-counter risk). Email-only, gentle cadence.
  fraud: [
    { stepType: "email_day1", offsetHours: STEP_TIMING_FRAUD_EMAIL_DAY1_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
  // The customer explicitly revoked authorization. The single send IS the hold.
  revoked: [{ stepType: "email_revoked", offsetHours: STEP_TIMING_REVOKED_EMAIL_HOURS }],
  // Unrecognized/unmapped decline codes fail closed: no silent retry against a
  // code the engine cannot classify. The expired emails' days (email carrying
  // the card-update link), without expired's guarded day 21 retry.
  unknown: [
    { stepType: "email_day1", offsetHours: STEP_TIMING_EMAIL_DAY1_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
};

export const WIN_BACK_SCHEDULE: { stepNumber: number; offsetHours: number }[] = [
  { stepNumber: 1, offsetHours: WINBACK_STEP1_HOURS },
  { stepNumber: 2, offsetHours: WINBACK_STEP2_HOURS },
  { stepNumber: 3, offsetHours: WINBACK_STEP3_HOURS },
];

export interface PlanRecoveryInput {
  failedPaymentId: string;
  accountId: string;
  declineCategory: DeclineCategory;
  /** When the failure was detected; step scheduledAt = detectedAt + offset. */
  detectedAt: Date;
}

/** A recovery_steps insert row (subset of columns the planner sets). */
export interface PlannedRecoveryStep {
  failedPaymentId: string;
  accountId: string;
  stepType: string;
  stepNumber: number;
  scheduledAt: Date;
}

/** Plan the full recovery_steps sequence for a failed payment. */
export function planRecoverySteps(input: PlanRecoveryInput): PlannedRecoveryStep[] {
  const schedule = RECOVERY_SCHEDULES[input.declineCategory];
  return schedule.map((step, i) => ({
    failedPaymentId: input.failedPaymentId,
    accountId: input.accountId,
    stepType: step.stepType,
    stepNumber: i + 1,
    scheduledAt: new Date(input.detectedAt.getTime() + step.offsetHours * HOUR_MS),
  }));
}
