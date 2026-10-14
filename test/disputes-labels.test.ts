import { describe, expect, it } from "vitest";

import { disputeStateTone, isDisputeResolved } from "~/lib/disputes/labels";

describe("disputeStateTone", () => {
  it("resolved_won is success, resolved_lost is failure", () => {
    expect(disputeStateTone("resolved_won")).toBe("success");
    expect(disputeStateTone("resolved_lost")).toBe("failure");
  });

  it("every pre-resolution state is neutral, never the brand accent", () => {
    expect(disputeStateTone("draft")).toBe("neutral");
    expect(disputeStateTone("pending_review")).toBe("neutral");
    expect(disputeStateTone("approved")).toBe("neutral");
    expect(disputeStateTone("submitted")).toBe("neutral");
  });
});

describe("isDisputeResolved", () => {
  it("true only for the two resolved states", () => {
    expect(isDisputeResolved("resolved_won")).toBe(true);
    expect(isDisputeResolved("resolved_lost")).toBe(true);
    expect(isDisputeResolved("submitted")).toBe(false);
    expect(isDisputeResolved("draft")).toBe(false);
  });
});
