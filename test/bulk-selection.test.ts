import { describe, expect, it } from "vitest";

import { actionableSelection } from "~/lib/recovery/bulk-results";

// The selection model is Capsomer's; Foxhound's gate is that the count and the request are one set.

const PAGE = [
  { id: "p1", status: "active" },
  { id: "p2", status: "recovered" },
  { id: "p3", status: "active" },
  { id: "p4", status: "cancelled" },
];

describe("bulk selection: the actionable subset is the only set an action may use", () => {
  it("count and request are one set", () => {
    const selected = new Set(["p1", "p2", "p3", "p4", "off_page"]);
    expect(actionableSelection(selected, PAGE)).toEqual(["p1", "p3"]);
  });
});
