import { describe, expect, it } from "vitest";

import { recoveryLifecycleStatus, recoveryLifecycleTone } from "~/lib/recovery/labels";

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
