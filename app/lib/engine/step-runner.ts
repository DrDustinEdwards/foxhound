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

// Step-run deciders: the pure brain of the recovery engine. Given the outcome of
// a step's side effect, they decide the recovery_steps patch and (for a succeeded
// retry) whether a recovery must be recorded. They are pure so the orchestration
// is proven without a live Stripe charge or a live email send.
//
// BOUNDARY: the live executors call these. `executeRetryStep` wraps
// `decideRetryStep` around a real stripe.invoices.pay + the step persistence + the
// reconcileRetryRecovery money-write; `executeEmailStep` wraps `decideEmailStep`
// around the content resolution (email-generation.ts) + the EMAIL-binding send +
// the step persistence. Those live calls hit Stripe/email and are exercised on
// staging in Phase 4c (end-to-end verification deferred to Phase 8 per the
// recovery plan).

export type StepAction = "retry" | "email";

/** Which kind of side effect a step performs, from its step_type prefix. */
export function stepAction(stepType: string): StepAction | null {
  if (isRetryStep(stepType)) return "retry";
  if (isEmailStep(stepType)) return "email";
  return null;
}

// ---- Retry steps ----

/** The result of a live stripe.invoices.pay attempt for a retry step. */
export interface RetryAttempt {
  /** Invoice status returned by invoices.pay (e.g. "paid"), if the call resolved. */
  invoiceStatus?: string | null;
  /** The error invoices.pay threw, if it rejected. Mutually exclusive with invoiceStatus. */
  error?: unknown;
  /** Set when the call threw so we classify the error rather than the status. */
  threw?: boolean;
  /** Not charged: the invoice read just before the charge was not payable
   *  (paid, void, draft). Its status. */
  invoiceClosedStatus?: string;
  /** Not charged: Stripe still has its own attempt scheduled on the invoice. */
  stripeRetrying?: boolean;
}

export interface RetryStepDecision {
  retryResult: RetryResult;
  /** The recovery_steps columns to set. A retry step is terminal in one attempt. */
  patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: RetryResult };
  /** True when the retry succeeded and the caller must record a foxhound_retry recovery. */
  recovered: boolean;
}

/**
 * Decide the outcome of a retry step. A retry either succeeds (charge went
 * through, record a foxhound_retry recovery) or does not; unlike an email send, a
 * failed retry is not rescheduled with backoff, it just resolves the step and the
 * sequence moves to its next scheduled step.
 */
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

// ---- Email steps ----

/** The result of a live email send for an email step. */
export interface SendAttempt {
  /** True when the provider accepted the message. */
  ok: boolean;
  /** For a failure: true when it is permanent (invalid recipient etc.), false when transient. */
  permanent?: boolean;
  /** For a failure: the error string recorded on last_attempt_error. */
  error?: string;
}

/**
 * Decide the recovery_steps patch after an email send attempt. A success marks the
 * step sent. A transient failure runs the send-attempt backoff machine (reschedule
 * up to SEND_MAX_ATTEMPTS, then terminal email_failed); a permanent failure is
 * terminal immediately.
 */
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
