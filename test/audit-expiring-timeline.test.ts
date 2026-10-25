import { describe, expect, it } from "vitest";

import { drawExpiringCardsTimeline } from "~/lib/audit/timeline";

// The expiring-cards chart once refused to draw when every month had the same
// count: the peak is then the only series, but the colors still named the
// "Cards expiring" series, and Enarratio rejects a color for a series that is
// not in the chart.
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
    expect(svg).toContain("Most cards expiring");
  });
});
