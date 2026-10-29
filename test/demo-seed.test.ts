import { beforeEach, describe, expect, it } from "vitest";

import { getRecoveryStats, getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { getIntelligenceOverview } from "~/lib/intelligence/views.server";
import {
  listFailedPayments,
} from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The demo seeder must make every real surface render populated data through its
// NORMAL loader. This drives the actual loader query functions against the seeded
// in-memory DB (real migrated schema), so a missing column or wrong enum value
// fails here, not in production.
//
// TASK-foxhound-demo-data-engine.md ported the legacy six-module demo engine
// (customer-base, recovery-seed, disputes-seed, intelligence-seed, narratives-
// seed) in place of the prior thin sketch, so every count below reflects the
// richer, near-verbatim-ported dataset: 200 Teamflow customers (7 scripted
// narratives) + 7 net-new dispute-only customers, the day-walk failed-payment
// simulator, the 8-dispute Teamflow set, and 12 monthly MRR snapshots built
// from the real movement math.

const now = new Date("2026-07-21T00:00:00.000Z");

describe("demo seeder -> real loaders render populated data", () => {
  let db: ReturnType<typeof createInMemoryDb>["db"];
  beforeEach(async () => {
    db = createInMemoryDb().db;
    await seedDemoAccount(db, now);
  });

  it("dashboard: recovery stats + MRR analytics are populated", async () => {
    const stats = await getRecoveryStats(db, DEMO_ACCOUNT_ID, now.getTime());
    expect(stats.totalFailedCount).toBeGreaterThan(0);
    expect(stats.recoveredCount).toBeGreaterThan(0);
    expect(stats.revenueRecovered.length).toBeGreaterThan(0);

    const mrr = await getMrrAnalytics(db, DEMO_ACCOUNT_ID, now.getTime());
    expect(mrr.latest).not.toBeNull();
    expect(mrr.trend).toHaveLength(12);
    // Believable Teamflow-scale portfolio (200 customers).
    expect(mrr.latest!.totalMrrCents).toBeGreaterThan(2_000_000);
    expect(mrr.latest!.totalMrrCents).toBeLessThan(3_500_000);
  });

  it("intelligence: overview populated, at-risk anchors present", async () => {
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    // 200 base customers + 7 net-new dispute-only customers (Harborline is
    // already one of the 200, not net-new).
    expect(overview.scoredCustomerCount).toBe(207);
    expect(overview.atRiskCustomerCount).toBeGreaterThanOrEqual(2);
    expect(overview.narrative).not.toBeNull();
    expect(overview.mrrAtRiskCents).toBeGreaterThan(0);
  });

  it("is deterministic + idempotent: re-seeding yields the same single portfolio", async () => {
    await seedDemoAccount(db, now); // second run on top of the first
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(207); // not 414
    expect((await listFailedPayments(db, DEMO_ACCOUNT_ID)).length).toBe(76);
  });
});
