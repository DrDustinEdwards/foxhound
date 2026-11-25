import { describe, expect, it } from "vitest";

import { tallyStatusCounts } from "~/lib/recovery/queries.server";

// "Stop recovery" writes a distinct `cancelled` status; every place that tallies statuses must count it on its own.

describe("canceled status: counting", () => {
  it("counts canceled on its own and never folds it into not-recovered", () => {
    const counts = tallyStatusCounts([
      "active",
      "active",
      "recovered",
      "failed_unrecovered",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(counts).toEqual({
      all: 7,
      active: 2,
      recovered: 1,
      failedUnrecovered: 1,
      cancelled: 3,
    });
  });
});
