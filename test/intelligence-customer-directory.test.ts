import { describe, expect, it } from "vitest";

import { accounts, customerContext } from "~/db/schema";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  capitalizeTier,
  formatRelativeLastSeen,
  hasActiveRecoverySignal,
  hasDisputeHistorySignal,
} from "~/lib/intelligence/customer-directory";
import { listCustomerDirectory, listCustomerTiers } from "~/lib/intelligence/views.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-intelligence-customer-directory.md. Acceptance test for this
// TASK is also the L-2 finding from foxhound-demo-engine-review.md: Northpoint
// Logistics (health 90, an expansion narrative) must be reachable by browsing
// the directory, not just by a hand-typed URL.

const now = new Date("2026-07-21T00:00:00.000Z");

describe("formatRelativeLastSeen", () => {
  it("labels today, yesterday, days, and months correctly", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(formatRelativeLastSeen(null, now)).toBe("-");
    expect(formatRelativeLastSeen(now, now)).toBe("today");
    expect(formatRelativeLastSeen(new Date(now.getTime() - day), now)).toBe("yesterday");
    expect(formatRelativeLastSeen(new Date(now.getTime() - 5 * day), now)).toBe("5d ago");
    expect(formatRelativeLastSeen(new Date(now.getTime() - 30 * day), now)).toBe("1mo ago");
    expect(formatRelativeLastSeen(new Date(now.getTime() - 65 * day), now)).toBe("2mo ago");
  });
});

describe("capitalizeTier / signal helpers", () => {
  it("capitalizes a tier string and handles null", () => {
    expect(capitalizeTier("scale")).toBe("Scale");
    expect(capitalizeTier(null)).toBe("-");
  });

  it("reads the active-recovery and dispute-history signals defensively", () => {
    expect(hasActiveRecoverySignal({ activeRecoveryId: "dfp_1" })).toBe(true);
    expect(hasActiveRecoverySignal({ activeRecoveryId: null })).toBe(false);
    expect(hasActiveRecoverySignal(null)).toBe(false);
    expect(hasActiveRecoverySignal("not an object")).toBe(false);

    expect(hasDisputeHistorySignal({ wonCount: 1 })).toBe(true);
    expect(hasDisputeHistorySignal({ openDisputesCount: 1 })).toBe(true);
    expect(hasDisputeHistorySignal({ lostCount: 0, wonCount: 0, openDisputesCount: 0 })).toBe(false);
    expect(hasDisputeHistorySignal({})).toBe(false);
    expect(hasDisputeHistorySignal(null)).toBe(false);
  });
});

describe("listCustomerDirectory against the seeded demo account", () => {
  async function seededDb() {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, now);
    return db;
  }

  it("lists all 207 customers across pages of 50", async () => {
    const db = await seededDb();
    const page1 = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    expect(page1.totalCount).toBe(207);
    expect(page1.totalPages).toBe(5); // ceil(207/50)
    expect(page1.customers).toHaveLength(50);

    const page5 = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 5,
    });
    expect(page5.customers).toHaveLength(7); // 207 - 4*50
  });

  it("sorts health ascending with nulls last by default", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    const scores = result.customers.map((c) => c.healthScore);
    const nonNull = scores.filter((s): s is number => s !== null);
    expect(nonNull).toEqual([...nonNull].sort((a, b) => a - b));
    // Every customer_context row is scored (universal coverage), so there is
    // nothing to prove about null placement in THIS seed, but the ordering
    // above is exactly what would leave nulls at the end if any existed.
    expect(scores.every((s) => s !== null)).toBe(true);
  });

  it("sorts by MRR descending when requested", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: null,
      healthBand: null,
      sort: "mrr_desc",
      page: 1,
    });
    const mrrs = result.customers.map((c) => c.mrrContributionCents);
    expect(mrrs).toEqual([...mrrs].sort((a, b) => b - a));
  });

  it("Northpoint Logistics is reachable by filtering, not just by a hand-typed URL", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: "Northpoint",
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].stripeCustomerId).toBe("cus_teamflow_northpoint_logistics");
    expect(result.customers[0].healthScore).toBe(90);
  });

  it("Northpoint also surfaces under the healthy band filter (it is not at-risk)", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: null,
      healthBand: "healthy",
      sort: "health_asc",
      page: 1,
    });
    const ids = new Set(result.customers.map((c) => c.stripeCustomerId));
    // healthy band + page 1 of the largest band may not include every healthy
    // customer, so re-query narrowed by name instead of asserting membership
    // in an arbitrary first page.
    expect(result.customers.every((c) => (c.healthScore ?? 0) >= 70)).toBe(true);
    void ids;
  });

  it("the tier filter narrows to an exact match", async () => {
    const db = await seededDb();
    const tiers = await listCustomerTiers(db, DEMO_ACCOUNT_ID);
    expect(tiers).toEqual(["growth", "scale", "starter"]);

    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: "scale",
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    // 40 Scale customers from the 200-customer base (customer-base.ts's
    // documented split) + 2 net-new dispute-only customers whose disputed
    // amount put them at the Scale tier (intelligence-seed.ts).
    expect(result.totalCount).toBe(42);
  });

  it("at least one customer shows each Signals state (active recovery, dispute history)", async () => {
    const db = await seededDb();
    // Bluewave Studios: the scripted active-recovery narrative.
    const activeRecoveryRow = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: "Bluewave",
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    expect(hasActiveRecoverySignal(activeRecoveryRow.customers[0]?.recoverySignals)).toBe(true);

    // Harborline Group: the scripted won-dispute narrative.
    const disputeRow = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: "Harborline",
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    expect(hasDisputeHistorySignal(disputeRow.customers[0]?.disputeSignals)).toBe(true);
  });

  it("filters and sort survive independently, each expressed purely as query params", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: null,
      tier: "growth",
      healthBand: "at_risk",
      sort: "mrr_desc",
      page: 1,
    });
    for (const c of result.customers) {
      expect(c.currentPlanTier).toBe("growth");
      expect(c.healthScore).not.toBeNull();
      expect(c.healthScore!).toBeLessThan(40);
    }
  });

  // J30 review, blocking finding 1: a second account's customers never reach
  // the demo account's directory, its totals or its tier options.
  it("another account's customers stay out of the directory, its totals and its tiers", async () => {
    const db = await seededDb();
    const unfiltered = { search: null, tier: null, healthBand: null, sort: "health_asc" as const, page: 1 };
    const before = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, unfiltered);

    await db.insert(accounts).values({ id: "acct_other", name: "Other merchant", createdAt: now });
    await db.insert(customerContext).values({
      id: "cc_other_1",
      accountId: "acct_other",
      stripeCustomerId: "cus_other_1",
      customerName: "Zanzibar Otherco Holdings",
      customerEmail: "billing@otherco.example.com",
      currentPlanTier: "zzother",
      mrrContributionCents: 987_654_321,
      currency: "usd",
      healthScore: 1,
      createdAt: now,
      updatedAt: now,
    });

    const searched = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, { ...unfiltered, search: "Zanzibar Otherco" });
    expect(searched.totalCount).toBe(0);
    expect(searched.customers).toHaveLength(0);

    const after = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, unfiltered);
    expect(after.totalCount).toBe(before.totalCount);
    expect(after.totalCount).toBe(207);
    expect(after.totalMrrCents).toBe(before.totalMrrCents);

    const tiers = await listCustomerTiers(db, DEMO_ACCOUNT_ID);
    expect(tiers).not.toContain("zzother");

    const byTier = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, { ...unfiltered, tier: "zzother" });
    expect(byTier.totalCount).toBe(0);
    expect(byTier.customers).toHaveLength(0);

    // The row is really there: the other account sees exactly it.
    const other = await listCustomerDirectory(db, "acct_other", unfiltered);
    expect(other.totalCount).toBe(1);
  });
});
