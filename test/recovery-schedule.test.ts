import { describe, expect, it } from "vitest";

import {
  RECOVERY_SCHEDULES,
  isEmailStep,
  isRetryStep,
  planRecoverySteps,
} from "~/lib/recovery/schedule";
import { categoryGuidance } from "~/lib/recovery/email-generation";
import type { DeclineCategory } from "~/lib/constants";

describe("recovery schedules (silent-first)", () => {

  it("schedules are strictly increasing in time", () => {
    for (const category of Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]) {
      const offsets = RECOVERY_SCHEDULES[category].map((s) => s.offsetHours);
      for (let i = 1; i < offsets.length; i += 1) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    }
  });
});

describe("revoked authorization: one-step hold", () => {
  const detectedAt = new Date("2026-07-01T00:00:00.000Z");

  it("plans exactly one email step and nothing else", () => {
    const plan = planRecoverySteps({
      failedPaymentId: "fp_rev",
      accountId: "acc_1",
      declineCategory: "revoked",
      detectedAt,
    });
    expect(plan.length).toBe(1);
    expect(plan[0].stepNumber).toBe(1);
    expect(isEmailStep(plan[0].stepType)).toBe(true);
    expect(plan.some((p) => isRetryStep(p.stepType))).toBe(false);
    // Sent soon (2h), a prompt cancel-or-update ask, not a delayed dunning cadence.
    expect(plan[0].scheduledAt.getTime()).toBe(detectedAt.getTime() + 2 * 3600_000);
  });

  it("frames the copy as a cancel-or-update choice, not a dunning ask", () => {
    const guidance = categoryGuidance("revoked");
    expect(guidance).not.toBeNull();
    expect(guidance!.toLowerCase()).toContain("revoked");
    expect(guidance!.toLowerCase()).toMatch(/do not ask them to pay/);
    // Other categories keep the default framing (no special guidance).
    expect(categoryGuidance("soft")).toBeNull();
    expect(categoryGuidance("fraud")).toBeNull();
  });
});
