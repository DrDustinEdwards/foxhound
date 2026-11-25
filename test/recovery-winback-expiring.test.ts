import { describe, expect, it } from "vitest";

import { isCardExpired, isCardExpiringSoon } from "~/lib/recovery/expiring-card";

describe("expiring-card pre-dunning", () => {
  const now = new Date("2026-07-15T00:00:00.000Z"); // July 2026

  it("flags a card expiring this month or next (within 1 month)", () => {
    expect(isCardExpiringSoon(2026, 7, now)).toBe(true); // this month
    expect(isCardExpiringSoon(2026, 8, now)).toBe(true); // next month
    expect(isCardExpiringSoon(2026, 9, now)).toBe(false); // two months out
  });

  it("flags an already-expired card as expiring soon and expired", () => {
    expect(isCardExpiringSoon(2026, 6, now)).toBe(true);
    expect(isCardExpired(2026, 6, now)).toBe(true);
    expect(isCardExpired(2026, 7, now)).toBe(false); // current month still valid
  });
});
