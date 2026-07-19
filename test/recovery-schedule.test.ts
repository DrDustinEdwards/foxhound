import { describe, expect, it } from "vitest";

import { classifyDecline, isRetryable } from "~/lib/recovery/decline";
import {
  RECOVERY_SCHEDULES,
  isEmailStep,
  isRetryStep,
  planRecoverySteps,
} from "~/lib/recovery/schedule";
import type { DeclineCategory } from "~/lib/constants";

describe("classifyDecline", () => {
  it("maps codes to categories and fails closed on unknown/null to 'unknown', not 'soft'", () => {
    expect(classifyDecline("insufficient_funds")).toBe("soft");
    expect(classifyDecline("processing_error")).toBe("network");
    expect(classifyDecline("expired_card")).toBe("expired");
    expect(classifyDecline("stolen_card")).toBe("fraud");
    expect(classifyDecline("something_unknown")).toBe("unknown");
    expect(classifyDecline(null)).toBe("unknown");
    expect(classifyDecline(undefined)).toBe("unknown");
  });

  it("does not regress previously-correct soft codes (still retryable)", () => {
    for (const code of [
      "insufficient_funds",
      "do_not_honor",
      "generic_decline",
      "card_declined",
      "transaction_not_allowed",
      "withdrawal_count_limit_exceeded",
    ]) {
      expect(classifyDecline(code)).toBe("soft");
      expect(isRetryable(classifyDecline(code))).toBe(true);
    }
  });

  it("routes revocation_of_authorization and do_not_try_again to fraud (never retried)", () => {
    expect(classifyDecline("revocation_of_authorization")).toBe("fraud");
    expect(classifyDecline("do_not_try_again")).toBe("fraud");
    expect(isRetryable(classifyDecline("revocation_of_authorization"))).toBe(false);
    expect(isRetryable(classifyDecline("do_not_try_again"))).toBe(false);
  });

  it("never retries the documented never-retry set", () => {
    const neverRetryCodes = [
      "lost_card",
      "stolen_card",
      "fraudulent",
      "pickup_card",
      "restricted_card",
      "security_violation",
      "do_not_try_again",
      "revocation_of_authorization",
    ];
    for (const code of neverRetryCodes) {
      expect(isRetryable(classifyDecline(code))).toBe(false);
    }
  });

  it("marks only soft and network as retryable; unknown fails closed like expired/fraud", () => {
    expect(isRetryable("soft")).toBe(true);
    expect(isRetryable("network")).toBe(true);
    expect(isRetryable("expired")).toBe(false);
    expect(isRetryable("fraud")).toBe(false);
    expect(isRetryable("unknown")).toBe(false);
  });
});

describe("recovery schedules (silent-first)", () => {
  it("leads retryable declines with a silent retry before any email", () => {
    for (const category of ["soft", "network"] as DeclineCategory[]) {
      const steps = RECOVERY_SCHEDULES[category];
      const firstEmailIdx = steps.findIndex((s) => isEmailStep(s.stepType));
      const firstRetryIdx = steps.findIndex((s) => isRetryStep(s.stepType));
      expect(firstRetryIdx).toBe(0);
      expect(firstRetryIdx).toBeLessThan(firstEmailIdx);
    }
  });

  it("never retries fraud (issuer fraud-counter risk)", () => {
    expect(RECOVERY_SCHEDULES.fraud.some((s) => isRetryStep(s.stepType))).toBe(false);
  });

  it("never retries expired cards (they re-decline)", () => {
    expect(RECOVERY_SCHEDULES.expired.some((s) => isRetryStep(s.stepType))).toBe(false);
    expect(isEmailStep(RECOVERY_SCHEDULES.expired[0].stepType)).toBe(true);
  });

  it("never retries unknown/unmapped codes (fail closed, no data to safely retry)", () => {
    expect(RECOVERY_SCHEDULES.unknown.some((s) => isRetryStep(s.stepType))).toBe(false);
    expect(isEmailStep(RECOVERY_SCHEDULES.unknown[0].stepType)).toBe(true);
  });

  it("schedules are strictly increasing in time", () => {
    for (const category of Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]) {
      const offsets = RECOVERY_SCHEDULES[category].map((s) => s.offsetHours);
      for (let i = 1; i < offsets.length; i += 1) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    }
  });
});

describe("planRecoverySteps", () => {
  it("produces 1-based ordered steps scheduled off detectedAt", () => {
    const detectedAt = new Date("2026-07-01T00:00:00.000Z");
    const plan = planRecoverySteps({
      failedPaymentId: "fp_1",
      accountId: "acc_1",
      declineCategory: "soft",
      detectedAt,
    });

    expect(plan.length).toBe(RECOVERY_SCHEDULES.soft.length);
    expect(plan[0].stepNumber).toBe(1);
    expect(plan[0].stepType).toBe("retry_early");
    expect(plan.map((p) => p.stepNumber)).toEqual(plan.map((_, i) => i + 1));
    expect(plan.every((p) => p.failedPaymentId === "fp_1" && p.accountId === "acc_1")).toBe(true);

    // retry_early is 4h after detection.
    expect(plan[0].scheduledAt.getTime()).toBe(detectedAt.getTime() + 4 * 3600_000);
    // Last step (email_day30) is 720h after detection.
    expect(plan.at(-1)!.scheduledAt.getTime()).toBe(detectedAt.getTime() + 720 * 3600_000);
  });
});
