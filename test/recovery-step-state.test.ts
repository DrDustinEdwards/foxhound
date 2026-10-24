import { describe, expect, it } from "vitest";

import {
  afterPermanentFailure,
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

describe("retry-result classification", () => {

  it("classifies thrown errors: card errors decline, others error", () => {
    expect(classifyRetryError({ type: "StripeCardError" })).toBe("retry_card_declined");
    expect(classifyRetryError({ type: "StripeAPIError" })).toBe("retry_error");
    expect(classifyRetryError(new Error("boom"))).toBe("retry_error");
  });
});
