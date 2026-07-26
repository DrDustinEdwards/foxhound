import { SEND_MAX_ATTEMPTS, SEND_RETRY_BACKOFF_MINUTES } from "~/lib/constants";

// The recovery_steps send-attempt state machine (SCHEMA.md: attempt_count,
// last_attempt_error, next_retry_at folded into the design). A transient send
// failure keeps the step UNEXECUTED and reschedules it with backoff, up to
// SEND_MAX_ATTEMPTS, then it goes terminal. A permanent failure is terminal
// immediately. Pure, so the state logic is proven without a live send.

const MIN_MS = 60_000;

/** The columns a state transition sets on a recovery_steps row. */
export interface StepStatePatch {
  attemptCount: number;
  lastAttemptError: string | null;
  nextRetryAt: Date | null;
  executedAt: Date | null;
  result: string | null;
}

/** How a transient failure is bounded: how many attempts before the step goes
 *  terminal, and what result it lands on when it does. */
export interface TransientFailurePolicy {
  maxAttempts: number;
  terminalResult: string;
}

/**
 * The generic bounded-retry transition. Increments the attempt count; if
 * attempts are exhausted the step is terminal with the policy's result,
 * otherwise it is left UNEXECUTED with next_retry_at set from the backoff table
 * (last value repeats). Leaving it unexecuted is what makes stepDueCondition
 * pick it up again, and what keeps it "pending" for the exhausted-sequence
 * sweep so a sequence still waiting on a backoff is never flipped.
 *
 * Generalized from the send-only version so the retry executor can share it:
 * a retry step with no connected token is a transient condition too (the
 * merchant is mid-reconnect), and used to go terminal on the very first tick.
 * See RETRY_TOKEN_MAX_ATTEMPTS and review MEDIUM-2.
 */
export function afterTransientFailureWith(
  attemptCount: number,
  error: string,
  now: Date,
  policy: TransientFailurePolicy,
): StepStatePatch {
  const newCount = attemptCount + 1;
  if (newCount >= policy.maxAttempts) {
    return {
      attemptCount: newCount,
      lastAttemptError: error,
      nextRetryAt: null,
      executedAt: now,
      result: policy.terminalResult,
    };
  }
  const idx = Math.min(newCount - 1, SEND_RETRY_BACKOFF_MINUTES.length - 1);
  const backoffMin = SEND_RETRY_BACKOFF_MINUTES[idx];
  return {
    attemptCount: newCount,
    lastAttemptError: error,
    nextRetryAt: new Date(now.getTime() + backoffMin * MIN_MS),
    executedAt: null,
    result: null,
  };
}

/**
 * Next state after a TRANSIENT send failure (retryable). Increments the attempt
 * count; if attempts are exhausted the step is terminal (`email_failed`),
 * otherwise it is left unexecuted with next_retry_at set from the backoff table
 * (last value repeats).
 */
export function afterTransientFailure(
  attemptCount: number,
  error: string,
  now: Date,
): StepStatePatch {
  return afterTransientFailureWith(attemptCount, error, now, {
    maxAttempts: SEND_MAX_ATTEMPTS,
    terminalResult: "email_failed",
  });
}

/** Next state after a PERMANENT send failure: terminal immediately. */
export function afterPermanentFailure(
  attemptCount: number,
  error: string,
  now: Date,
): StepStatePatch {
  return {
    attemptCount: attemptCount + 1,
    lastAttemptError: error,
    nextRetryAt: null,
    executedAt: now,
    result: "email_failed",
  };
}

// ---- Retry-step (Stripe invoices.pay) result classification ----

export type RetryResult =
  | "retry_succeeded"
  | "retry_card_declined"
  | "retry_error"
  | "retry_failed"
  /** The account has no usable connected-account token, so the charge was never
   *  attempted. Distinct from retry_error (a charge that was attempted and blew
   *  up) because the cause and the fix are different: this one means the
   *  merchant disconnected Stripe, and it is the merchant who has to act. Kept
   *  queryable on its own so "how many steps died because a merchant is
   *  disconnected" is one WHERE clause, not a guess. */
  | "retry_no_connection";

/** Classify a completed invoices.pay call by the resulting invoice status. */
export function classifyRetryStatus(invoiceStatus: string | null | undefined): RetryResult {
  return invoiceStatus === "paid" ? "retry_succeeded" : "retry_failed";
}

/** Classify a thrown Stripe error: card errors are declines, others are errors. */
export function classifyRetryError(err: unknown): RetryResult {
  const type = (err as { type?: string } | null)?.type;
  return type === "StripeCardError" ? "retry_card_declined" : "retry_error";
}

export function isRetrySucceeded(result: RetryResult): boolean {
  return result === "retry_succeeded";
}
