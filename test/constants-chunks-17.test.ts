import { describe, expect, it } from "vitest";

import {
  SEND_MAX_ATTEMPTS,
  SEND_RETRY_BACKOFF_MINUTES,
  WINBACK_STEP1_HOURS,
  WINBACK_STEP2_HOURS,
  WINBACK_STEP3_HOURS,
} from "~/lib/constants";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { afterTransientFailure } from "~/lib/recovery/step-state";

// Parity CHUNKS item 17 value pins. (Per 291 a numbered citation names its
// numbering: this is CHUNKS item 17, the constants trio, not volume ruling 17.
// The FILENAME still says ruling-17 and is left alone as churn; reported.)
//
// The ruling's finding was that three constants changed with no comment, no
// commit-message mention and no decision record, and that nothing would catch a
// silent change back. The first fix restored the values and pinned only one of
// them (the AI-cost ceil), which reproduced the exact condition the ruling
// exists to prevent: reverting the other two passed CI green.
//
// These are deliberately VALUE tests, not symbolic ones. Every other test in the
// suite uses SEND_MAX_ATTEMPTS symbolically (`SEND_MAX_ATTEMPTS - 1`), which is
// correct for those tests and is precisely why none of them notices the number
// changing. Something has to assert the number itself.

describe("CHUNKS item 17: win-back window", () => {
  it("spans 14 days, the legacy value", () => {
    expect(WINBACK_STEP3_HOURS).toBe(336);
  });

  it("carries legacy's INTERIOR steps too, aligned by 291", () => {
    // The interiors were 24h and 72h against legacy's 1h and 96h. 291 ruled the
    // divergence a defect: the earlier restoration reached only the outer bound,
    // and the blame finding above is proof the interiors were never ratified.
    // Pinned as VALUES for the same reason step 3 is: the symbolic assertion
    // below cannot notice a number changing.
    expect(WINBACK_STEP1_HOURS).toBe(1);
    expect(WINBACK_STEP2_HOURS).toBe(96);
  });

  it("is the span the planner actually schedules, not just a loose constant", () => {
    // Pinning the constant alone would not catch WIN_BACK_SCHEDULE being rewired
    // to a different one, so assert the last step the planner emits.
    expect(WIN_BACK_SCHEDULE.at(-1)?.offsetHours).toBe(336);
    expect(WIN_BACK_SCHEDULE.map((s) => s.offsetHours)).toEqual([
      WINBACK_STEP1_HOURS,
      WINBACK_STEP2_HOURS,
      WINBACK_STEP3_HOURS,
    ]);
  });
});

describe("CHUNKS item 17: send-retry policy", () => {
  it("allows 5 attempts", () => {
    expect(SEND_MAX_ATTEMPTS).toBe(5);
  });

  it("carries one backoff entry per non-terminal attempt, so the clamp is not load-bearing", () => {
    // The clamp in afterTransientFailureWith stays as a safety net for a future
    // change to SEND_MAX_ATTEMPTS. It must not be the mechanism that produces
    // the shipped cadence, which is what a table shorter than this would mean.
    expect(SEND_RETRY_BACKOFF_MINUTES.length).toBe(SEND_MAX_ATTEMPTS - 1);
    expect([...SEND_RETRY_BACKOFF_MINUTES]).toEqual([15, 60, 240, 720]);
  });

  it("strictly increases, so the tail is real backoff rather than a flat repeat", () => {
    const waits = [...SEND_RETRY_BACKOFF_MINUTES];
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBeGreaterThan(waits[i - 1]);
    }
  });
});

describe("CHUNKS item 17: the grace span the state machine actually produces", () => {
  // Walks the REAL transition function rather than re-reading the table, so this
  // fails if the table, the count, or the clamp logic changes the lived cadence.
  function walkGrace(): { waitsMinutes: number[]; terminalAtAttempt: number } {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const waitsMinutes: number[] = [];
    let attemptCount = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const next = afterTransientFailure(attemptCount, "transient", t0);
      if (next.result !== null) return { waitsMinutes, terminalAtAttempt: next.attemptCount };
      waitsMinutes.push((next.nextRetryAt!.getTime() - t0.getTime()) / 60_000);
      attemptCount = next.attemptCount;
    }
    throw new Error("send-retry walk did not terminate");
  }

  it("reschedules four times then goes terminal on the fifth", () => {
    const { waitsMinutes, terminalAtAttempt } = walkGrace();
    expect(waitsMinutes).toEqual([15, 60, 240, 720]);
    expect(terminalAtAttempt).toBe(SEND_MAX_ATTEMPTS);
  });

  it("totals legacy's ~17.25 hours of grace", () => {
    const totalMinutes = walkGrace().waitsMinutes.reduce((a, b) => a + b, 0);
    expect(totalMinutes).toBe(1035);
    expect(totalMinutes / 60).toBeCloseTo(17.25, 5);
  });
});
