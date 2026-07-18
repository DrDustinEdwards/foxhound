import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_KIND_LABELS,
  failedPaymentStatusTone,
  formatStepResult,
  formatStepType,
  recoveryLifecycleStatus,
  recoveryLifecycleTone,
  stepResultTone,
} from "~/lib/recovery/labels";

describe("stepResultTone", () => {
  it("neutral when there is no result yet", () => {
    expect(stepResultTone(null)).toBe("neutral");
  });
  it("success for a completed retry or sent email", () => {
    expect(stepResultTone("retry_succeeded")).toBe("success");
    expect(stepResultTone("email_sent")).toBe("success");
  });
  it("failure for a declined retry or a failed send", () => {
    expect(stepResultTone("retry_card_declined")).toBe("failure");
    expect(stepResultTone("retry_error")).toBe("failure");
    expect(stepResultTone("retry_failed")).toBe("failure");
    expect(stepResultTone("email_failed")).toBe("failure");
  });
  it("falls back to neutral on an unrecognized result rather than throwing", () => {
    expect(stepResultTone("something_new")).toBe("neutral");
  });
});

describe("failedPaymentStatusTone", () => {
  it("recovered is success, everything else is neutral (never amber)", () => {
    expect(failedPaymentStatusTone("recovered")).toBe("success");
    expect(failedPaymentStatusTone("active")).toBe("neutral");
  });
});

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

  it("refunded takes priority if both are somehow set", () => {
    const both = { refundedAt: new Date("2026-07-18"), disputedAt: new Date("2026-07-18") };
    expect(recoveryLifecycleStatus(both)).toBe("refunded");
  });
});

describe("ATTRIBUTION_KIND_LABELS", () => {
  it("is a plain factual label for every kind, never a fee or billing claim", () => {
    for (const label of Object.values(ATTRIBUTION_KIND_LABELS)) {
      expect(label).not.toMatch(/\$|fee|bill/i);
    }
  });
});
