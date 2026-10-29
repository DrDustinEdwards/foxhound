import { describe, expect, it } from "vitest";

import { applyNetworkAdvice, pickDeclineCode } from "~/lib/recovery/decline";

// The network's advice code is stronger than a soft or unreadable decline code:
// "do_not_try_again" must never be silently retried, and "confirm_card_data"
// goes to the card-update path. A stricter category is never loosened.
describe("applyNetworkAdvice", () => {
  it("moves soft, network and unknown declines on do_not_try_again and confirm_card_data", () => {
    for (const category of ["soft", "network", "unknown"] as const) {
      expect(applyNetworkAdvice(category, "do_not_try_again")).toBe("fraud");
      expect(applyNetworkAdvice(category, "confirm_card_data")).toBe("expired");
      expect(applyNetworkAdvice(category, "try_again_later")).toBe(category);
      expect(applyNetworkAdvice(category, null)).toBe(category);
    }
  });

  it("never changes an expired, fraud or revoked decline", () => {
    for (const category of ["expired", "fraud", "revoked"] as const) {
      expect(applyNetworkAdvice(category, "do_not_try_again")).toBe(category);
      expect(applyNetworkAdvice(category, "confirm_card_data")).toBe(category);
    }
  });
});

describe("pickDeclineCode", () => {
  it("prefers a specific code over the generic card_declined, in the order given", () => {
    expect(pickDeclineCode([null, "card_declined", "insufficient_funds"])).toBe("insufficient_funds");
    expect(pickDeclineCode(["expired_card", "insufficient_funds"])).toBe("expired_card");
    expect(pickDeclineCode([undefined, "card_declined"])).toBe("card_declined");
    expect(pickDeclineCode([null, undefined])).toBeNull();
  });
});
