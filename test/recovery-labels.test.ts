import { describe, expect, it } from "vitest";

import { formatStepResult, formatStepType, recoveryLifecycleStatus, recoveryLifecycleTone } from "~/lib/recovery/labels";

describe("formatStepType", () => {
  it("formats retry and email step types with their timing detail", () => {
    expect(formatStepType("retry_early")).toBe("Retry (early)");
    expect(formatStepType("retry_4hr")).toBe("Retry (4hr)");
    expect(formatStepType("retry_day2")).toBe("Retry (day 2)");
    expect(formatStepType("email_day1")).toBe("Email (day 1)");
    expect(formatStepType("email_day30")).toBe("Email (day 30)");
  });
});

describe("formatStepResult", () => {
  it("humanizes a snake_case result", () => {
    expect(formatStepResult("retry_succeeded")).toBe("Retry Succeeded");
    expect(formatStepResult("retry_card_declined")).toBe("Retry Card Declined");
    expect(formatStepResult("email_sent")).toBe("Email Sent");
  });
});

describe("recoveryLifecycleStatus / recoveryLifecycleTone", () => {
  it("a clean recovery (no refund, no dispute) reads as recovered/success", () => {
    const clean = { refundedAt: null, disputedAt: null };
    expect(recoveryLifecycleStatus(clean)).toBe("recovered");
    expect(recoveryLifecycleTone(clean)).toBe("success");
  });

  it("recovered-then-refunded never reads as a clean win, regardless of attribution", () => {
    const refunded = { refundedAt: new Date("2026-07-18"), disputedAt: null };
    expect(recoveryLifecycleStatus(refunded)).toBe("refunded");
    expect(recoveryLifecycleTone(refunded)).toBe("failure");
  });

  it("recovered-then-disputed never reads as a clean win, regardless of attribution", () => {
    const disputed = { refundedAt: null, disputedAt: new Date("2026-07-18") };
    expect(recoveryLifecycleStatus(disputed)).toBe("disputed");
    expect(recoveryLifecycleTone(disputed)).toBe("failure");
  });
});
