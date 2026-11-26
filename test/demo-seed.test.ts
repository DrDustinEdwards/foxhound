import { beforeEach, describe, expect, it } from "vitest";

import { getRecoveryStats, getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { DEMO_ACCOUNT_ID, DEMO_BOLT_ACCOUNT_ID } from "~/lib/demo/constants";
import { BOLT_DISPUTE_SPECS, TEAMFLOW_DISPUTE_SPECS } from "~/lib/demo/disputes-specs";
import { seedDemoAccount } from "~/lib/demo/seed";
import { getIntelligenceOverview } from "~/lib/intelligence/views.server";
import { listFailedPayments } from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The seeded demo renders populated data through the real loaders, so a schema drift fails here.

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
  });

  it("intelligence: overview populated, at-risk anchors present", async () => {
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(207);
    expect(overview.atRiskCustomerCount).toBeGreaterThanOrEqual(2);
    expect(overview.narrative).not.toBeNull();
    expect(overview.mrrAtRiskCents).toBeGreaterThan(0);
  });

  it("seeds the second business, Bolt Analytics, as its own populated account", async () => {
    const stats = await getRecoveryStats(db, DEMO_BOLT_ACCOUNT_ID, now.getTime());
    expect(stats.totalFailedCount).toBeGreaterThan(0);
    expect(stats.recoveredCount).toBeGreaterThan(0);

    const overview = await getIntelligenceOverview(db, DEMO_BOLT_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(203);
    expect(overview.mrrAtRiskCents).toBeGreaterThan(0);
  });

  it("is deterministic + idempotent: re-seeding yields the same single portfolio", async () => {
    await seedDemoAccount(db, now); // second run on top of the first
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(207); // not 414
    expect((await listFailedPayments(db, DEMO_ACCOUNT_ID)).length).toBe(76);
  });
});

// The public demo shows these addresses, so none may sit on a real company's domain.
describe("demo dispute customers", () => {
  it("use only the reserved .demo domain", () => {
    for (const spec of [...TEAMFLOW_DISPUTE_SPECS, ...BOLT_DISPUTE_SPECS]) {
      expect(spec.customerEmail).toMatch(/@[a-z0-9-]+\.demo$/);
    }
  });
});
