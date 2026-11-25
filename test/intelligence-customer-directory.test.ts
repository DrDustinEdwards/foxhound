import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  formatRelativeLastSeen,
  hasActiveRecoverySignal,
  hasDisputeHistorySignal,
  planTierPill,
} from "~/lib/intelligence/customer-directory";
import { listCustomerDirectory, listCustomerTiers } from "~/lib/intelligence/directory.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

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

describe("signal helpers", () => {
  it("reads the active-recovery and dispute-history signals defensively", () => {
    expect(hasActiveRecoverySignal({ activeRecoveryId: "dfp_1" })).toBe(true);
    expect(hasActiveRecoverySignal({ activeRecoveryId: null })).toBe(false);
    expect(hasActiveRecoverySignal(null)).toBe(false);
    expect(hasActiveRecoverySignal("not an object")).toBe(false);

    expect(hasDisputeHistorySignal({ wonCount: 1 })).toBe(true);
    expect(hasDisputeHistorySignal({ openDisputesCount: 1 })).toBe(true);
    expect(hasDisputeHistorySignal({ lostCount: 0, wonCount: 0, openDisputesCount: 0 })).toBe(
      false,
    );
    expect(hasDisputeHistorySignal({})).toBe(false);
    expect(hasDisputeHistorySignal(null)).toBe(false);
  });
});

describe("planTierPill", () => {
  it("gives a dash for no tier, never a raw database value, and matches free text whatever its case or space", () => {
    expect(planTierPill(null).label).toBe("-");
    expect(planTierPill("enterprise").label).toBe("Enterprise");
    expect(planTierPill("Growth")).toEqual({ label: "Growth", tone: "info" });
    expect(planTierPill("SCALE")).toEqual({ label: "Scale" });
    expect(planTierPill(" pro ")).toEqual({ label: "Pro" });
    expect(planTierPill("Starter").label).toBe("Starter");
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

  it("a customer is reachable by name search", async () => {
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

  it("a search typed with LIKE wildcards matches them literally", async () => {
    const db = await seededDb();
    const result = await listCustomerDirectory(db, DEMO_ACCOUNT_ID, {
      search: "%",
      tier: null,
      healthBand: null,
      sort: "health_asc",
      page: 1,
    });
    expect(result.customers).toHaveLength(0);
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
});
