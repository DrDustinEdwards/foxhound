import { describe, expect, it } from "vitest";

import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import {
  isLastWinbackStep,
  isWinbackTerminal,
  nextWinbackStatus,
  planWinbackSteps,
} from "~/lib/recovery/winback";

describe("win-back state machine (terminal-state fix)", () => {
  it("reactivation wins over everything", () => {
    expect(
      nextWinbackStatus({ reactivated: true, resolvedElsewhere: true, isLastStep: false }),
    ).toBe("reactivated");
  });

  it("last step with no reactivation is EXHAUSTED, never left active", () => {
    expect(
      nextWinbackStatus({ reactivated: false, resolvedElsewhere: false, isLastStep: true }),
    ).toBe("exhausted");
  });

  it("stays active only mid-sequence", () => {
    expect(
      nextWinbackStatus({ reactivated: false, resolvedElsewhere: false, isLastStep: false }),
    ).toBe("active");
  });

  it("resolved-elsewhere is terminal", () => {
    expect(
      nextWinbackStatus({ reactivated: false, resolvedElsewhere: true, isLastStep: false }),
    ).toBe("resolved");
    expect(isWinbackTerminal("resolved")).toBe(true);
    expect(isWinbackTerminal("active")).toBe(false);
  });

  it("plans 3 steps and flags the last", () => {
    const steps = planWinbackSteps({
      winBackSequenceId: "seq_1",
      accountId: "acc_1",
      canceledAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(steps.length).toBe(3);
    expect(isLastWinbackStep(steps.at(-1)!.stepNumber)).toBe(true);
    expect(isLastWinbackStep(1)).toBe(false);
  });
});

describe("expiring-card pre-dunning", () => {
  const now = new Date("2026-07-15T00:00:00.000Z"); // July 2026

  it("flags a card expiring this month or next (within 1 month)", () => {
    expect(isCardExpiringSoon(2026, 7, now)).toBe(true); // this month
    expect(isCardExpiringSoon(2026, 8, now)).toBe(true); // next month
    expect(isCardExpiringSoon(2026, 9, now)).toBe(false); // two months out
  });

  it("flags an already-expired card as expiring soon and expired", () => {
    expect(isCardExpiringSoon(2026, 6, now)).toBe(true);
    expect(isCardExpired(2026, 6, now)).toBe(true);
    expect(isCardExpired(2026, 7, now)).toBe(false); // current month still valid
  });

  it("respects a wider lookahead window", () => {
    expect(isCardExpiringSoon(2026, 10, now, 3)).toBe(true);
    expect(isCardExpiringSoon(2026, 11, now, 3)).toBe(false);
  });
});
