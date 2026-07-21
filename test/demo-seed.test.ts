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
    // Believable portfolio near the legacy ~$26k figure.
    expect(mrr.latest!.totalMrrCents).toBeGreaterThan(2_000_000);
    expect(mrr.latest!.totalMrrCents).toBeLessThan(3_200_000);
  });

  it("recovery: list, active subset, and a detail timeline render", async () => {
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    expect(all.length).toBe(44);
    const active = await listActiveFailedPayments(db, DEMO_ACCOUNT_ID);
    expect(active.length).toBeGreaterThan(0);

    const detail = await getFailedPaymentDetail(db, DEMO_ACCOUNT_ID, "demo_fp_0");
    expect(detail).not.toBeNull();
    expect(detail!.steps.length).toBeGreaterThan(0);
  });

  it("recovery: winback + expiring-cards surfaces have data", async () => {
    expect((await listWinbackSequences(db, DEMO_ACCOUNT_ID)).length).toBe(5);
    expect((await listExpiringCardAlerts(db, DEMO_ACCOUNT_ID)).length).toBe(8);
  });

  it("disputes: list + a won detail with evidence and approval", async () => {
    const list = await listDisputes(db, DEMO_ACCOUNT_ID);
    expect(list.length).toBe(6);
    const won = list.find((d) => d.state === "resolved_won");
    expect(won).toBeTruthy();
    expect(won!.resolvedFeeCents).toBeGreaterThan(0);

    const detail = await getDisputeDetail(db, DEMO_ACCOUNT_ID, won!.id);
    expect(detail).not.toBeNull();
    expect(detail!.evidence.length).toBeGreaterThan(0);
    expect(detail!.approval).not.toBeNull();
  });

  it("intelligence: entitled, overview populated, at-risk anchors present", async () => {
    expect(await isIntelligenceEntitled(db, DEMO_ACCOUNT_ID)).toBe(true);

    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(185);
    expect(overview.atRiskCustomerCount).toBeGreaterThanOrEqual(2);
    expect(overview.narrative).not.toBeNull();
    expect(overview.mrrAtRiskCents).toBeGreaterThan(0);
  });

  it("intelligence: a high-risk customer detail has a health sparkline", async () => {
    const detail = await getCustomerHealthDetail(db, DEMO_ACCOUNT_ID, "demo_cus_0");
    expect(detail).not.toBeNull();
    expect(detail!.healthScore).toBe(20);
    expect(detail!.history.length).toBeGreaterThan(0);
  });

  it("intelligence: alerts + reports surfaces have data", async () => {
    const alertsView = await getAlertsView(db, DEMO_ACCOUNT_ID);
    expect(alertsView.alerts.length).toBe(2);
    expect(alertsView.history.length).toBe(1);
    expect((await getReportsArchive(db, DEMO_ACCOUNT_ID)).length).toBe(1);
  });

  it("is deterministic + idempotent: re-seeding yields the same single portfolio", async () => {
    await seedDemoAccount(db, now); // second run on top of the first
    const overview = await getIntelligenceOverview(db, DEMO_ACCOUNT_ID);
    expect(overview.scoredCustomerCount).toBe(185); // not 370
    expect((await listFailedPayments(db, DEMO_ACCOUNT_ID)).length).toBe(44);
  });
});
