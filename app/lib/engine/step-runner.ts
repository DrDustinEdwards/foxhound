import { isEmailStep, isRetryStep } from "~/lib/recovery/schedule";
import {
  afterPermanentFailure,
  afterTransientFailure,
  classifyRetryError,
  classifyRetryStatus,
  isRetrySucceeded,
  type RetryResult,
  type StepStatePatch,
} from "~/lib/recovery/step-state";

// Step-run deciders: the pure brain of the recovery engine. Given a step's side-effect outcome, decide the
// recovery_steps patch and whether a recovery must be recorded. executeRetryStep and executeEmailStep wrap
// these with the live Stripe/email calls and persistence.

export type StepAction = "retry" | "email";

export function stepAction(stepType: string): StepAction | null {
  if (isRetryStep(stepType)) return "retry";
  if (isEmailStep(stepType)) return "email";
  return null;
}

export interface RetryAttempt {
  invoiceStatus?: string | null;
  error?: unknown;
  threw?: boolean;
  /** Not charged: the invoice read just before the charge was not payable; its status. */
  invoiceClosedStatus?: string;
  stripeRetrying?: boolean;
}

export interface RetryStepDecision {
  retryResult: RetryResult;
  patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: RetryResult };
  recovered: boolean;
}

/** Decide a retry step's outcome. A failed retry is not rescheduled with backoff; it resolves the step and the sequence moves on. */
export function decideRetryStep(attempt: RetryAttempt, now: Date): RetryStepDecision {
  const retryResult: RetryResult = attempt.threw
    ? classifyRetryError(attempt.error)
    : classifyRetryStatus(attempt.invoiceStatus);
  const recovered = isRetrySucceeded(retryResult);
  return {
    retryResult,
    patch: { executedAt: now, result: retryResult, retryResult },
    recovered,
  };
}

export interface SendAttempt {
  ok: boolean;
  permanent?: boolean;
  error?: string;
}

/** Decide the patch after an email send attempt: success marks the step sent; a transient failure runs the
 *  backoff (up to SEND_MAX_ATTEMPTS, then terminal email_failed); a permanent failure is terminal. */
export function decideEmailStep(
  step: { attemptCount: number },
  attempt: SendAttempt,
  now: Date,
): StepStatePatch {
  if (attempt.ok) {
    return {
      attemptCount: step.attemptCount + 1,
      lastAttemptError: null,
      nextRetryAt: null,
      executedAt: now,
      result: "email_sent",
    };
  }
  const error = attempt.error ?? "send failed";
  return attempt.permanent
    ? afterPermanentFailure(step.attemptCount, error, now)
    : afterTransientFailure(step.attemptCount, error, now);
}
