import { describe, expect, it } from "vitest";

import { buildDisputesSeed } from "~/lib/demo/disputes-seed";

// TASK-foxhound-demo-data-engine.md Phase 3: the 8-dispute Teamflow set,
// mapped onto Foxhound's real dispute state machine + approval gate.

const now = new Date("2026-07-21T00:00:00.000Z");
const ACCOUNT_ID = "demo_teamflow";
const MEMBER_EMAIL = "demo@foxhoundapp.com";

function seed() {
  return buildDisputesSeed(ACCOUNT_ID, now, MEMBER_EMAIL);
}

describe("buildDisputesSeed", () => {
  it("is deterministic", () => {
    const a = seed();
    const b = seed();
    expect(b).toEqual(a);
  });

  it("builds exactly 8 disputes", () => {
    expect(seed().disputes).toHaveLength(8);
  });

  it("attaches the won dispute to Harborline Group directly (no placeholder identity)", () => {
    const { disputes } = seed();
    const harborline = disputes.find((d) => d.stripeCustomerId === "cus_teamflow_harborline_group");
    expect(harborline).toBeTruthy();
    expect(harborline!.state).toBe("resolved_won");
    expect(harborline!.customerName).toBe("Harborline Group");
  });

  it("every Foxhound-submitted dispute has an approval row; every non-submitted one does not", () => {
    const { disputes, disputeApprovals } = seed();
    const approvedIds = new Set(disputeApprovals.map((a) => a.disputeId));
    for (const d of disputes) {
      if (d.submittedBy !== null) {
        expect(approvedIds.has(d.id as string)).toBe(true);
      } else {
        expect(approvedIds.has(d.id as string)).toBe(false);
      }
    }
  });

  it("a merchant-won dispute (not Foxhound-submitted) carries no resolved fee, even though it won", () => {
    const { disputes } = seed();
    const merchantWon = disputes.find((d) => d.customerName === "Sara Lin");
    expect(merchantWon).toBeTruthy();
    expect(merchantWon!.state).toBe("resolved_won");
    expect(merchantWon!.submittedBy).toBeNull();
    expect(merchantWon!.resolvedFeeCents).toBeNull();
  });

  it("a Foxhound-submitted won dispute has a resolved fee capped at $500", () => {
    const { disputes } = seed();
    const won = disputes.filter((d) => d.state === "resolved_won" && d.submittedBy !== null);
    expect(won.length).toBeGreaterThan(0);
    for (const d of won) {
      expect(d.resolvedFeeCents).not.toBeNull();
      expect(d.resolvedFeeCents!).toBeLessThanOrEqual(50_000);
      expect(d.resolvedFeeCents!).toBe(Math.round(d.amountCents * 0.2) > 50_000 ? 50_000 : Math.round(d.amountCents * 0.2));
    }
  });

  it("a lost dispute never carries a resolved fee", () => {
    const { disputes } = seed();
    const lost = disputes.filter((d) => d.state === "resolved_lost");
    expect(lost.length).toBeGreaterThan(0);
    for (const d of lost) expect(d.resolvedFeeCents).toBeNull();
  });

  it("every dispute id referenced by evidence/approvals belongs to a real dispute", () => {
    const { disputes, disputeEvidence, disputeApprovals } = seed();
    const ids = new Set(disputes.map((d) => d.id));
    for (const e of disputeEvidence) expect(ids.has(e.disputeId)).toBe(true);
    for (const a of disputeApprovals) expect(ids.has(a.disputeId)).toBe(true);
  });
});
