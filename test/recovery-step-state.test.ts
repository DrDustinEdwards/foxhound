import { describe, expect, it } from "vitest";

import { SEND_MAX_ATTEMPTS } from "~/lib/constants";
import {
  afterPermanentFailure,
  afterTransientFailure,
  classifyRetryError,
} from "~/lib/recovery/step-state";

const now = new Date("2026-07-03T00:00:00.000Z");

describe("send-attempt state machine", () => {
  it("a permanent failure is terminal immediately", () => {
    const s = afterPermanentFailure(0, "invalid recipient", now);
    expect(s.result).toBe("email_failed");
    expect(s.executedAt).toEqual(now);
    expect(s.nextRetryAt).toBeNull();
    expect(s.attemptCount).toBe(1);
  });
});

// A value test on purpose: other tests use SEND_MAX_ATTEMPTS symbolically, so none
// would notice the number changing. This walks the real transition function, so
// it fails if the backoff table, the count or the clamp changes the lived cadence.
describe("send-retry cadence", () => {
  it("reschedules four times at 15, 60, 240 and 720 minutes, then goes terminal on the fifth", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const waitsMinutes: number[] = [];
    let attemptCount = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const next = afterTransientFailure(attemptCount, "transient", t0);
      if (next.result !== null) {
        expect(next.attemptCount).toBe(SEND_MAX_ATTEMPTS);
        expect(waitsMinutes).toEqual([15, 60, 240, 720]);
        return;
      }
      waitsMinutes.push((next.nextRetryAt!.getTime() - t0.getTime()) / 60_000);
      attemptCount = next.attemptCount;
    }
    throw new Error("send-retry walk did not terminate");
  });
});

describe("retry-result classification", () => {
  it("classifies thrown errors: card errors decline, others error", () => {
    expect(classifyRetryError({ type: "StripeCardError" })).toBe("retry_card_declined");
    expect(classifyRetryError({ type: "StripeAPIError" })).toBe("retry_error");
    expect(classifyRetryError(new Error("boom"))).toBe("retry_error");
  });
});
