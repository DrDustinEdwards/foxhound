
import { describe, expect, it } from "vitest";

import { recoveryRateValueClass, showingCountFor } from "~/lib/recovery/payments-stats";


// S6's LAST two build items, raised by 279 and assigned by 284: the stat-card
// value colors and the Showing card with its pill-responsiveness.
//
// LEGACY IS THE SPEC and was read WHOLE at source rather than inherited from the
// row: app/(app)/recovery/payments/components/PaymentsStats.tsx, blob b386c66,
// 1,249 bytes, and its call site in PaymentsClient.tsx (blob 9404389, 12,701
// bytes). Legacy's five cards and their colorClass values:
//
//   Showing        text-text          <- StatCard's own default, so no prop
//   Active         text-brand-text
//   Recovered      text-green
//   Canceled      text-text-subtle   <- landed at 352de6a
//   Recovery rate  >=36 text-green, >=21 text-caution (legacy: its accent text), else text-red
//
// TWO INHERITED COUNTS ARE REFUTED HERE, both measured from that read:
//   * 279 and the S6 row say legacy passes colors on FOUR cards and Foxhound on
//     none. Legacy passes one on ALL FIVE, and Foxhound already carried
//     Canceled's. Showing's legacy color IS StatCard's default, so it is not a
//     divergence at all. THREE cards were outstanding, not four.
//   * 279 says the Showing item is "the LABEL plus pill-responsiveness". The
//     label and the value mechanism are both real, and there is a THIRD part it
//     did not name: Foxhound carried a `subtext="all filters"` that legacy has
//     no counterpart for. Removing it restores legacy, which is a repair and
//     never a ratified divergence.





describe("S6 recovery-rate color: legacy's thresholds, both boundaries inclusive", () => {
  it("36 and above is green", () => {
    expect(recoveryRateValueClass(36)).toBe("text-green");
    expect(recoveryRateValueClass(100)).toBe("text-green");
  });

  it("21 to 35 is caution", () => {
    expect(recoveryRateValueClass(21)).toBe("text-caution");
    expect(recoveryRateValueClass(35)).toBe("text-caution");
  });

  it("below 21 is red", () => {
    expect(recoveryRateValueClass(20)).toBe("text-red");
    expect(recoveryRateValueClass(0)).toBe("text-red");
  });
});

describe("S6 Showing card: legacy's global count, responding only to the pill", () => {

  it("each pill reads its own global count, never a filtered one", () => {
    const counts = { all: 10, active: 4, recovered: 3, cancelled: 2, failedUnrecovered: 1 };
    expect(showingCountFor(counts, "active")).toBe(4);
    expect(showingCountFor(counts, "recovered")).toBe(3);
    expect(showingCountFor(counts, "cancelled")).toBe(2);
    expect(showingCountFor(counts, "failed_unrecovered")).toBe(1);
  });

  it("an unrecognized status falls back to the total, legacy's own `?? all`", () => {
    // Foxhound's status arrives from the URL, so this branch is reachable by
    // hand-editing a query string. Legacy's index-with-fallback is ported rather
    // than dropped.
    const counts = { all: 10, active: 4, recovered: 3, cancelled: 2, failedUnrecovered: 1 };
    expect(showingCountFor(counts, "nonsense")).toBe(10);
  });
});
