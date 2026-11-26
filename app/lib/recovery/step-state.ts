import {
  type DeclineCategory,
  SEND_MAX_ATTEMPTS,
  SEND_RETRY_BACKOFF_MINUTES,
} from "~/lib/constants";
import { applyNetworkAdvice, classifyDecline, pickDeclineCode } from "~/lib/recovery/decline";
import { isEmailStep } from "~/lib/recovery/schedule";

// The recovery_steps send-attempt state machine (SCHEMA.md: attempt_count, last_attempt_error,
// next_retry_at folded into the design).

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
 * The generic bounded-retry transition. Leaving it unexecuted is what makes stepDueCondition pick
 * it up again, and what keeps it "pending" for the exhausted-sequence sweep so a sequence still
 * waiting on a backoff is never flipped.
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

/** Next state after a TRANSIENT send failure (retryable). */
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

/** An email step the merchant's "Email customers" switch held back: executed, nothing sent. */
export const EMAIL_SKIPPED_SENDS_OFF = "email_skipped_sends_off";

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

export type RetryResult =
  | "retry_succeeded"
  | "retry_card_declined"
  | "retry_error"
  | "retry_failed"
  /** The account has no usable connected-account token, so the charge was never attempted. */
  | "retry_no_connection"
  /** An expired card's retry that was not attempted because the card has not
   *  changed since the decline, or because the change could not be checked
   *  (app/lib/engine/card-change.ts). Terminal: no charge was made. */
  | "retry_skipped_card_unchanged"
  | "retry_skipped_unverified"
  /**
   * A retry not attempted because the customer has a lost dispute with this account. Terminal: no
   * charge.
   */
  | "retry_skipped_dispute_lost"
  /** A retry not attempted because the declined charge carried the network
   *  advice code do_not_try_again (engine/retry-step.ts). Terminal: no charge. */
  | "retry_skipped_do_not_try_again"
  /** A retry not attempted because the row's decline is one no retry can fix
   *  (fraud, revoked, unknown), as a declined earlier retry can leave it
   *  (engine/retry-step.ts). Terminal: no charge. */
  | "retry_skipped_hard_decline"
  /** A retry not attempted because Stripe reported the invoice paid, void or
   *  otherwise not payable when read just before the charge. Terminal. */
  | "retry_skipped_invoice_closed"
  /** A retry not attempted because Stripe still has its own attempt scheduled
   *  on the invoice: Foxhound's retries wait for Stripe to stop. Terminal. */
  | "retry_skipped_stripe_retrying";

/** Classify a completed invoices.pay call by the resulting invoice status. */
export function classifyRetryStatus(invoiceStatus: string | null | undefined): RetryResult {
  return invoiceStatus === "paid" ? "retry_succeeded" : "retry_failed";
}

/** Classify a thrown Stripe error: card errors are declines, others are errors. */
export function classifyRetryError(err: unknown): RetryResult {
  const type = (err as { type?: string } | null)?.type;
  return type === "StripeCardError" ? "retry_card_declined" : "retry_error";
}

/**
 * Stripe refused the charge request because another request with the same idempotency key is in
 * flight (or was sent with other parameters, which a retry step never does).
 */
export function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { type?: string; code?: string } | null;
  return e?.type === "StripeIdempotencyError" || e?.code === "idempotency_key_in_use";
}

/** What a declined retry's card error says, classified as intake classifies a
 *  charge: the specific decline code over the generic one, then the network
 *  advice over the code (decline.ts). */
export interface RetryDeclineReading {
  declineCode: string | null;
  declineCategory: DeclineCategory;
  networkAdviceCode: string | null;
  networkDeclineCode: string | null;
}

/** The decline a thrown card error carries, or null for any other error. */
export function readRetryDecline(err: unknown): RetryDeclineReading | null {
  const e = err as {
    type?: string;
    code?: string;
    decline_code?: string;
    network_advice_code?: string;
    network_decline_code?: string;
  } | null;
  if (e?.type !== "StripeCardError") return null;
  const declineCode = pickDeclineCode([e.decline_code, e.code]);
  const networkAdviceCode = e.network_advice_code ?? null;
  return {
    declineCode,
    declineCategory: applyNetworkAdvice(classifyDecline(declineCode), networkAdviceCode),
    networkAdviceCode,
    networkDeclineCode: e.network_decline_code ?? null,
  };
}

export function isRetrySucceeded(result: RetryResult): boolean {
  return result === "retry_succeeded";
}

// Foxhound has to apply the same two gates in two places: the route component, to decide which
// buttons render, and the server dispatcher, to refuse a hand-crafted POST that the button would
// not have offered.

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
 * Read from PaymentDetailClient.tsx 7f54aa45: const pendingSteps = steps.filter(s => !s.executed_at
 * && !s.result) const nextStep = pendingSteps[0] || null Note this deliberately does NOT filter by
 * due time.
 */
export function nextPendingStep<T extends ManualActionStepRow>(steps: readonly T[]): T | null {
  return steps.find((s) => s.executedAt === null && s.result === null) ?? null;
}

/** The last executed email step that has a stored subject and body, for "Resend last email". */
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
