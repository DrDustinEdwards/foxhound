import { SEND_MAX_ATTEMPTS, SEND_RETRY_BACKOFF_MINUTES } from "~/lib/constants";
import { isEmailStep } from "~/lib/recovery/schedule";

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

// ---- Manual-action preconditions (S7 Phase 2) ----
//
// Legacy gates two of its four manual actions on the state of the step list, and
// it does so in the CLIENT (PaymentDetailClient.tsx at blob 7f54aa45). Foxhound
// has to apply the same two gates in two places: the route component, to decide
// which buttons render, and the server dispatcher, to refuse a hand-crafted POST
// that the button would not have offered. These selectors exist so those two
// places cannot drift apart, which is the failure this campaign keeps finding
// when the same predicate is written twice.
//
// Pure and free of any db or env import, so the route component can call them
// without pulling server code into its client chunk.

/** The step-row fields the two selectors read. Structural rather than the schema
 *  row type, so a loader row, a demo row and a test fixture all satisfy it. */
export interface ManualActionStepRow {
  executedAt: Date | null;
  result: string | null;
  stepType: string;
  aiSubject: string | null;
  aiBodyHtml: string | null;
}

/**
 * Legacy's `nextStep`, the gate for "Trigger next step now": the FIRST step with
 * neither an execution nor a result. Read from PaymentDetailClient.tsx 7f54aa45:
 *
 *   const pendingSteps = steps.filter(s => !s.executed_at && !s.result)
 *   const nextStep = pendingSteps[0] || null
 *
 * Note this deliberately does NOT filter by due time. A manual trigger is the
 * merchant overriding the schedule, so a step scheduled for tomorrow is still
 * the next one to fire; that is legacy's behavior and the whole point of the
 * button.
 */
export function nextPendingStep<T extends ManualActionStepRow>(steps: readonly T[]): T | null {
  return steps.find((s) => s.executedAt === null && s.result === null) ?? null;
}

/**
 * Legacy's `lastEmailStep`, the gate for "Resend last email": the last EXECUTED
 * email step that carries generated copy. Read from PaymentDetailClient.tsx
 * 7f54aa45 lines 149 and 154:
 *
 *   const emailSteps = steps.filter(s => s.step_type.startsWith('email_') && s.executed_at)
 *   const lastEmailStep = emailSteps.filter(s => s.ai_subject && s.ai_body_html).slice(-1)[0]
 *
 * ORDERING, settled by Session D (268). Legacy disagrees with ITSELF here: its
 * CLIENT picks by array order (`slice(-1)`) while its resend ROUTE re-queries
 * ordered by `executed_at` descending. **Legacy's SERVER rule wins**, because the
 * server is what actually chooses the mail to send and the client's array order
 * is an artifact of whatever order its query happened to return. The
 * disagreement is legacy's own and is not reconciled here, only decided.
 *
 * Picking the maximum `executed_at` rather than the last array element also
 * makes this selector order-independent, which matters because
 * getFailedPaymentDetail's steps query carries no ORDER BY: relying on array
 * position would have made the chosen email depend on SQLite's row order.
 *
 * Ties (two steps sharing an identical `executed_at`) fall back to the later
 * array position, so the result stays deterministic rather than arbitrary.
 *
 * The EXISTENCE answer is unchanged by any of this, which is what keeps the
 * button's render gate and the server's choice in agreement.
 */
export function lastResendableEmailStep<T extends ManualActionStepRow>(
  steps: readonly T[],
): T | null {
  const resendable = steps.filter(
    (s) => s.executedAt !== null && isEmailStep(s.stepType) && s.aiSubject && s.aiBodyHtml,
  );
  return resendable.reduce<T | null>((best, step) => {
    if (best === null) return step;
    // >= keeps the later array position on an exact tie.
    return step.executedAt!.getTime() >= best.executedAt!.getTime() ? step : best;
  }, null);
}
