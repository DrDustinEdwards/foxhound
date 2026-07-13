import { describe, expect, it } from "vitest";

import { isCronEnabled, isDueByInterval } from "~/lib/cron/gating";

const now = new Date("2026-07-12T03:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("isCronEnabled (admin opt-out)", () => {
  it("enabled by default when there is no config row", () => {
    expect(isCronEnabled(null)).toBe(true);
  });

  it("honors an explicit disable", () => {
    expect(isCronEnabled({ enabled: false, minIntervalMinutes: null })).toBe(false);
    expect(isCronEnabled({ enabled: true, minIntervalMinutes: 60 })).toBe(true);
  });
});

describe("isDueByInterval (min-interval gate)", () => {
  it("always due with no interval or no prior run", () => {
    expect(isDueByInterval(null, 60, now)).toBe(true);
    expect(isDueByInterval(minutesAgo(5), null, now)).toBe(true);
  });

  it("blocks a run inside the interval and allows it after", () => {
    expect(isDueByInterval(minutesAgo(30), 60, now)).toBe(false);
    expect(isDueByInterval(minutesAgo(90), 60, now)).toBe(true);
    expect(isDueByInterval(minutesAgo(60), 60, now)).toBe(true); // exactly at the boundary
  });
});
