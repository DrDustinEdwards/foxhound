import { describe, expect, it } from "vitest";

import { drawExpiringCardsTimeline } from "~/lib/audit/timeline";

// The chart must still draw when every month has the same count.
describe("expiring-cards timeline", () => {
  it("draws when every month has the same count", () => {
    const svg = drawExpiringCardsTimeline(
      [
        { label: "Oct 2026", count: 3 },
        { label: "Nov 2026", count: 3 },
      ],
      600,
    );
    expect(svg).not.toContain("could not be drawn");
  });
});
