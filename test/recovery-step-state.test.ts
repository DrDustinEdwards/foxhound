import { describe, expect, it } from "vitest";

import { SEND_MAX_ATTEMPTS } from "~/lib/constants";
import {
  afterPermanentFailure,
  afterTransientFailure,
  classifyRetryError,
  classifyRetryStatus,
  isRetrySucceeded,
} from "~/lib/recovery/step-state";

const now = new Date("2026-07-03T00:00:00.000Z");

describe("send-attempt state machine", () => {
  it("reschedules with backoff while attempts remain (stays unexecuted)", () => {
    const s = afterTransientFailure(0, "timeout", now);
    expect(s.attemptCount).toBe(1);
    expect(s.executedAt).toBeNull();
    expect(s.result).toBeNull();
    expect(s.nextRetryAt).not.toBeNull();
    // first backoff is 5 minutes
    expect(s.nextRetryAt!.getTime()).toBe(now.getTime() + 5 * 60_000);
    expect(s.lastAttemptError).toBe("timeout");
  });

  it("goes terminal (email_failed) once attempts are exhausted", () => {
    // attemptCount = SEND_MAX_ATTEMPTS - 1 means this failure is the last one
    const s = afterTransientFailure(SEND_MAX_ATTEMPTS - 1, "still failing", now);
    expect(s.attemptCount).toBe(SEND_MAX_ATTEMPTS);
    expect(s.result).toBe("email_failed");
    expect(s.executedAt).toEqual(now);
    expect(s.nextRetryAt).toBeNull();
  });

  it("a permanent failure is terminal immediately", () => {
    const s = afterPermanentFailure(0, "invalid recipient", now);
    expect(s.result).toBe("email_failed");
    expect(s.executedAt).toEqual(now);
    expect(s.nextRetryAt).toBeNull();
    expect(s.attemptCount).toBe(1);
  });
});

describe("retry-result classification", () => {
  it("classifies invoice status", () => {
    expect(classifyRetryStatus("paid")).toBe("retry_succeeded");
    expect(classifyRetryStatus("open")).toBe("retry_failed");
    expect(classifyRetryStatus(null)).toBe("retry_failed");
  });

  it("classifies thrown errors: card errors decline, others error", () => {
    expect(classifyRetryError({ type: "StripeCardError" })).toBe("retry_card_declined");
    expect(classifyRetryError({ type: "StripeAPIError" })).toBe("retry_error");
    expect(classifyRetryError(new Error("boom"))).toBe("retry_error");
  });

  it("isRetrySucceeded only for retry_succeeded", () => {
    expect(isRetrySucceeded("retry_succeeded")).toBe(true);
    expect(isRetrySucceeded("retry_card_declined")).toBe(false);
  });
});
