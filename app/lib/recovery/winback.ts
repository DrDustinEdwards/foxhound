import { WIN_BACK_SCHEDULE } from "./schedule";

// Win-back sequence state machine. The legacy bug was sequences stuck in
// 'active' forever; the rebuild fix is an explicit terminal-state machine: a
// sequence that runs its last step without reactivation goes `exhausted`, never
// stays active. One-sequence-per-subscription is enforced structurally by
// win_back_sequences_subscription_uq (schema), so this owns only the status
// transitions. Pure + unit-tested.

export const WINBACK_STATUS = {
  ACTIVE: "active",
  REACTIVATED: "reactivated",
  EXHAUSTED: "exhausted",
  RESOLVED: "resolved",
} as const;
export type WinbackStatus = (typeof WINBACK_STATUS)[keyof typeof WINBACK_STATUS];

export const WINBACK_TERMINAL_STATUSES: readonly WinbackStatus[] = [
  WINBACK_STATUS.REACTIVATED,
  WINBACK_STATUS.EXHAUSTED,
  WINBACK_STATUS.RESOLVED,
];

export function isWinbackTerminal(status: string): boolean {
  return (WINBACK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface WinbackTransitionInput {
  /** The subscription reactivated (the win we bill/celebrate). */
  reactivated: boolean;
  /** The subscription was hard-canceled / resolved outside the sequence. */
  resolvedElsewhere: boolean;
  /** This was the final scheduled step. */
  isLastStep: boolean;
}

/**
 * Decide the sequence status after a step runs. Terminal by construction: once
 * the last step has run with no reactivation, the sequence is `exhausted` - it
 * can never be left `active` (the legacy stuck-state bug).
 */
export function nextWinbackStatus(input: WinbackTransitionInput): WinbackStatus {
  if (input.reactivated) return WINBACK_STATUS.REACTIVATED;
  if (input.resolvedElsewhere) return WINBACK_STATUS.RESOLVED;
  if (input.isLastStep) return WINBACK_STATUS.EXHAUSTED;
  return WINBACK_STATUS.ACTIVE;
}

const HOUR_MS = 60 * 60 * 1000;

export interface PlannedWinbackStep {
  winBackSequenceId: string;
  accountId: string;
  stepNumber: number;
  scheduledAt: Date;
}

/**
 * Plan the win-back steps for a sequence, scheduled off the cancellation time.
 *
 * `step1OffsetHours` overrides step ONE only, which is legacy's exact shape:
 * `step.stepNumber === 1 ? step1OffsetHours : step.offsetHours`. It exists for
 * the Intelligence gate (291): on an account running Intelligence, a customer
 * NOT flagged `winback_priority` is DELAYED from the 1h default to 4h, to cut
 * noise on lower-value churners. Steps 2 and 3 are never touched, in legacy or
 * here. Omitted, the schedule is used as written.
 */
export function planWinbackSteps(input: {
  winBackSequenceId: string;
  accountId: string;
  canceledAt: Date;
  step1OffsetHours?: number;
}): PlannedWinbackStep[] {
  return WIN_BACK_SCHEDULE.map((step) => {
    const offsetHours =
      step.stepNumber === 1 && input.step1OffsetHours !== undefined
        ? input.step1OffsetHours
        : step.offsetHours;
    return {
      winBackSequenceId: input.winBackSequenceId,
      accountId: input.accountId,
      stepNumber: step.stepNumber,
      scheduledAt: new Date(input.canceledAt.getTime() + offsetHours * HOUR_MS),
    };
  });
}

/** True when `stepNumber` is the last scheduled win-back step. */
export function isLastWinbackStep(stepNumber: number): boolean {
  return stepNumber >= WIN_BACK_SCHEDULE.length;
}

/**
 * May this sequence still be resubscribed from its email's button (343
 * binding 4)?
 *
 * ONLY `reactivated` AND `resolved` REFUSE, and `exhausted` deliberately does
 * NOT. Legacy flips its own sequence terminal the moment step 3 is SENT
 * (`if (step.step_number === 3)` sets status 'completed' straight after the
 * claim), so gating the button on a non-terminal status would ship step 3 with
 * a button that is dead on arrival, in the one email whose subject is "Last
 * chance to reactivate your account". A customer who cancelled and has not
 * come back may act on the last email; a customer who already came back, or
 * whose sequence ended some other way, has nothing left to do here.
 */
export function isWinbackResubscribable(status: string): boolean {
  return status !== WINBACK_STATUS.REACTIVATED && status !== WINBACK_STATUS.RESOLVED;
}
