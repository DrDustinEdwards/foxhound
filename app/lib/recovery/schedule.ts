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

// Recovery schedules: the ordered steps run after a failed payment, per decline
// category. Ordering is SILENT-FIRST: retryable declines (soft, network) lead
// with a silent Foxhound retry BEFORE the first dunning email. Non-retryable
// declines (expired, fraud) cannot be silently recovered, so they lead with an
// email that carries the card-update link. Fraud never retries (a 21-day retry
// risks the issuer's fraud counter -> higher fees).
//
// This diverges from legacy, where soft and expired led with email_day1, and it
// is RATIFIED (Dustin, 2026-08-01, ruling 80). Retrying quietly before any
// customer-facing email is the better product under PRICING.md's outcome model:
// a transient card failure recovers without the merchant's customer being
// dunned over a blip, and Stripe-baseline recoveries are free anyway.
//
// The previous comment called this "a deliberate change from legacy" while
// citing PRICING.md, with no ratification line. That was the calcification
// pattern (a doc cited to overrule legacy's behavior) and it is struck: the
// ruling is the authority now, not the citation. Ruling 78's SequenceTimeline
// already renders from RECOVERY_SCHEDULES, so engine, diagram and copy agree.

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
    // Recova's network row: retry_day2 at 24 and email_day3 at 48, so the retry
    // still lands a day before the email it might make unnecessary.
    { stepType: "retry_day2", offsetHours: STEP_TIMING_NETWORK_RETRY_DAY2_HOURS },
    { stepType: "email_day3", offsetHours: STEP_TIMING_NETWORK_EMAIL_DAY3_HOURS },
    { stepType: "email_day7", offsetHours: STEP_TIMING_EMAIL_DAY7_HOURS },
    { stepType: "email_day14", offsetHours: STEP_TIMING_EMAIL_DAY14_HOURS },
    { stepType: "retry_day21", offsetHours: STEP_TIMING_RETRY_DAY21_HOURS },
    { stepType: "email_day30", offsetHours: STEP_TIMING_EMAIL_DAY30_HOURS },
  ],
  // Expired cards re-decline on retry; recovery needs a card update, so the first
  // step is the email that carries the update link. No early silent retry.
  // Recova's day 21 retry is kept, GUARDED: it charges only if the card changed
  // after the decline (Stripe's card updater, a different card, or the customer
  // on the hosted card page) and is skipped otherwise, because Mastercard
  // forbids retrying an expired-card decline on the same number and expiry.
  // The guard is executeRetryStep's (app/lib/engine/card-change.ts). Dustin
  // approved the guard on 2026-10-25 (decision card, "Yes, all three").
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
  // The customer explicitly revoked authorization. This is a hard stop, not a
  // recovery to push on: one email offering a clean choice (cancel, or add a new
  // payment method if they meant to keep the subscription), then the sequence
  // ends. No retry (the bank blocked charges) and no dunning cadence (it is not
  // an ability-to-pay failure). The single send IS the hold.
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

/**
 * Plan the full recovery_steps sequence for a failed payment. Pure: returns the
 * rows to insert (the intake writes them). stepNumber is 1-based in schedule
 * order; scheduledAt is detectedAt + the step's offset.
 */
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
