import { describe, expect, it } from "vitest";

import { actionableSelection } from "~/lib/recovery/bulk-results";

// S6 bulk selection. The selection model itself (pruned to what is on screen,
// page-scoped select-all, one-row toggles) is Capsomer's bulk-bar helpers and
// tested there. What stays here is Foxhound's gate: legacy's defect (scope 1.3
// and 1.4, GATE-VERSUS-SUBMIT) is that its count and its request set are
// different sets; here they are the same set by construction.

const PAGE = [
  { id: "p1", status: "active" },
  { id: "p2", status: "recovered" },
  { id: "p3", status: "active" },
  { id: "p4", status: "cancelled" },
];

describe("bulk selection: the actionable subset is the ONLY set an action may use", () => {
  it("COUNT AND REQUEST ARE ONE SET, which is the gate-versus-submit repair", () => {
    // Legacy's bar would label this "Trigger next step (2)" and then submit 4.
    // Here the label reads actionableSelection and so must the request, so the
    // number a merchant sees is the number of payments that can be touched.
    const selected = new Set(["p1", "p2", "p3", "p4", "off_page"]);
    expect(actionableSelection(selected, PAGE)).toEqual(["p1", "p3"]);
  });
});
