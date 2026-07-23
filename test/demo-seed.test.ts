import { beforeEach, describe, expect, it } from "vitest";

import { getRecoveryStats, getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { getDisputeDetail, listDisputes } from "~/lib/disputes/queries.server";
import {
  getCustomerHealthDetail,
  getAlertsView,
  getIntelligenceOverview,
  getReportsArchive,
  isIntelligenceEntitled,
} from "~/lib/intelligence/views.server";
import {
  getFailedPaymentDetail,
  listActiveFailedPayments,
  listExpiringCardAlerts,
  listFailedPayments,
  listWinbackSequences,
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

    const mrr = await getMrrAnalytics(db, DEMO_ACCOUNT_ID);
    expect(mrr.latest).not.toBeNull();
    expect(mrr.trend).toHaveLength(12);
    // Believable Teamflow-scale portfolio (200 customers).
    expect(mrr.latest!.totalMrrCents).toBeGreaterThan(2_000_000);
    expect(mrr.latest!.totalMrrCents).toBeLessThan(3_500_000);
  });

  it("recovery: list, active subset, and a detail timeline render", async () => {
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    expect(all.length).toBe(76);
    const active = await listActiveFailedPayments(db, DEMO_ACCOUNT_ID);
    expect(active.length).toBeGreaterThan(0);

    // dfp_1: Acme Industries' first scripted failure, recovered via retry.
    const detail = await getFailedPaymentDetail(db, DEMO_ACCOUNT_ID, "dfp_1");
    expect(detail).not.toBeNull();
    expect(detail!.failedPayment.status).toBe("recovered");
    expect(detail!.steps.length).toBeGreaterThan(0);
  });

  it("recovery: winback + expiring-cards surfaces have data", async () => {
    expect((await listWinbackSequences(db, DEMO_ACCOUNT_ID)).length).toBe(8);
    expect((await listExpiringCardAlerts(db, DEMO_ACCOUNT_ID)).length).toBe(10);
  });

  it("disputes: list + Harborline Group's won detail with evidence and approval", async () => {
    const list = await listDisputes(db, DEMO_ACCOUNT_ID);
    expect(list.length).toBe(8);
    const won = list.find((d) => d.stripeCustomerId === "cus_teamflow_harborline_group");
    expect(won).toBeTruthy();
    expect(won!.state).toBe("resolved_won");
    expect(won!.resolvedFeeCents).toBeGreaterThan(0);

    const detail = await getDisputeDetail(db, DEMO_ACCOUNT_ID, won!.id);
    expect(detail).not.toBeNull();
    expect(detail!.evidence.length).toBeGreaterThan(0);
    expect(detail!.approval).not.toBeNull();
  });

  it("disputes: a merchant-won dispute carries no resolved fee even though it won", async () => {
    const list = await listDisputes(db, DEMO_ACCOUNT_ID);
    const merchantWon = list.find((d) => d.customerName === "Sara Lin");
    expect(merchantWon).toBeTruthy();
    expect(merchantWon!.state).toBe("resolved_won");
    expect(merchantWon!.resolvedFeeCents).toBeNull();
  });

  it("intelligence: entitled, overview populated, at-risk anchors present", async () => {
    expect(await isIntelligenceEntitled(db, DEMO_ACCOUNT_ID)).toBe(true);

    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    // 200 base customers + 7 net-new dispute-only customers (Harborline is
    // already one of the 200, not net-new).
    expect(overview.scoredCustomerCount).toBe(207);
    expect(overview.atRiskCustomerCount).toBeGreaterThanOrEqual(2);
    expect(overview.narrative).not.toBeNull();
    expect(overview.mrrAtRiskCents).toBeGreaterThan(0);
  });

  it("intelligence: Bluewave Studios' active-recovery narrative has a health sparkline", async () => {
    const detail = await getCustomerHealthDetail(db, DEMO_ACCOUNT_ID, "cus_teamflow_bluewave_studios");
    expect(detail).not.toBeNull();
    expect(detail!.healthScore).toBe(28);
    expect(detail!.history.length).toBeGreaterThan(0);
  });

  it("intelligence: alerts + reports surfaces have data", async () => {
    const alertsView = await getAlertsView(db, DEMO_ACCOUNT_ID);
    expect(alertsView.alerts.length).toBe(3);
    expect(alertsView.history.length).toBe(1);
    expect((await getReportsArchive(db, DEMO_ACCOUNT_ID)).length).toBe(1);
  });

  it("is deterministic + idempotent: re-seeding yields the same single portfolio", async () => {
    await seedDemoAccount(db, now); // second run on top of the first
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(207); // not 414
    expect((await listFailedPayments(db, DEMO_ACCOUNT_ID)).length).toBe(76);
  });
});
