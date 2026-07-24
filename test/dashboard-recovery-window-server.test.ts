import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { getRecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-recovery-surface-parity.md Phase 1: the composed windowed
// read model, run against the real seeded demo account. Two things this
// proves that the pure-math unit tests can't: the queries actually compose
// correctly against the real schema, and the "one windowed function called
// twice" shape genuinely produces range-scoped vs range-invariant fields as
// designed - not asserted from reading the code, verified by calling it.

const now = new Date("2026-07-21T00:00:00.000Z");

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

describe("getRecoveryDashboardWindow structural sanity", () => {
  it("returns internally consistent, well-formed data for a 30d window", async () => {
    const db = await seededDb();
    const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());

    expect(w.rangeLabel).toBe("30d");
    expect(w.rangeDays).toBe(30);
    expect(w.totalFailedCount).toBeGreaterThan(0);
    expect(w.recoveredCount).toBeLessThanOrEqual(w.totalFailedCount);
    expect(w.recoveryRatePct).not.toBeNull();
    expect(w.recoveryRatePct as number).toBeGreaterThanOrEqual(0);
    expect(w.recoveryRatePct as number).toBeLessThanOrEqual(100);
    expect(w.recoveryRateDaily).toHaveLength(30);
    // Independent per-bucket rounding (direct port of legacy's own math) can
    // land a point or two off 100 in either direction; each bucket on its own
    // must still be a sane percentage.
    for (const bucket of w.recoveryTimingBuckets) {
      expect(bucket.percentage).toBeGreaterThanOrEqual(0);
      expect(bucket.percentage).toBeLessThanOrEqual(100);
    }
    expect(w.activePaymentsCount).toBeGreaterThanOrEqual(0);
    expect(w.activeWinbacksCount).toBeGreaterThan(0); // demo-seed guarantee
    expect(w.upcomingSteps.length).toBeGreaterThan(0);
    expect(w.recentPayments.length).toBeLessThanOrEqual(8);
    expect(w.connection).not.toBeNull(); // Teamflow simulates an actively connected merchant
    expect(w.webhookHealth?.tone).toBe("success"); // seeded lastWebhookAt is recent

    for (const category of Object.keys(w.categoryBreakdown)) {
      expect(DECLINE_CATEGORIES).toContain(category);
    }
    for (const p of w.emailCategoryPerformance) {
      expect(p.openRatePct).toBeGreaterThanOrEqual(0);
      expect(p.openRatePct).toBeLessThanOrEqual(100);
    }
    // Every sparkline series spans a genuine 30 days, regardless of the
    // window's own range (proven again here at the composed level, not just
    // in the pure-math unit tests).
    for (const series of Object.values(w.categorySparkline)) {
      expect(series).toHaveLength(30);
    }
  });

  it("never fabricates a currency amount: every group has a real ISO-ish currency string", async () => {
    const db = await seededDb();
    const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "all", now.getTime());
    for (const amount of [...w.recoveredRevenue, ...w.atRiskRevenue, ...w.reactivatedRevenue]) {
      expect(amount.currency).toBe("usd");
      expect(amount.cents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("getRecoveryDashboardWindow: the dual-range shape", () => {
  it("range-scoped fields differ between a narrow and a wide range", async () => {
    const db = await seededDb();
    const narrow = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "7d", now.getTime());
    const wide = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "90d", now.getTime());

    expect(narrow.totalFailedCount).toBeLessThanOrEqual(wide.totalFailedCount);
    expect(narrow.recoveryRateDaily).toHaveLength(7);
    expect(wide.recoveryRateDaily).toHaveLength(90);
  });

  it("range-invariant fields are identical across a narrow and a wide range call", async () => {
    const db = await seededDb();
    const narrow = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "7d", now.getTime());
    const wide = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "90d", now.getTime());

    // These describe current account state or an unscoped-by-range fact, so
    // they must read the same no matter which range the caller asked for -
    // exactly what lets a Phase 2 loader pick either call's result for them.
    expect(narrow.activePaymentsCount).toBe(wide.activePaymentsCount);
    expect(narrow.atRiskRevenue).toEqual(wide.atRiskRevenue);
    expect(narrow.activeWinbacksCount).toBe(wide.activeWinbacksCount);
    expect(narrow.expiringCardsCount).toBe(wide.expiringCardsCount);
    expect(narrow.connection).toEqual(wide.connection);
    expect(narrow.webhookHealth).toEqual(wide.webhookHealth);
    expect(narrow.lastRecoveryAgo).toBe(wide.lastRecoveryAgo);
    expect(narrow.upcomingSteps).toEqual(wide.upcomingSteps);
    expect(narrow.totalEmailsSent).toBe(wide.totalEmailsSent);
    expect(narrow.openRatePct).toBe(wide.openRatePct);
    expect(narrow.clickRatePct).toBe(wide.clickRatePct);
    expect(narrow.emailCategoryPerformance).toEqual(wide.emailCategoryPerformance);
    // The sparkline is always a trailing 30 days, independent of range too.
    expect(narrow.categorySparkline).toEqual(wide.categorySparkline);
  });

  it("calling with '30d' twice (simulating the reused-single-fetch case) is deterministic", async () => {
    const db = await seededDb();
    const a = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    const b = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    expect(a).toEqual(b);
  });
});
