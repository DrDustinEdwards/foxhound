import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { failedPayments, recoveredPayments } from "~/db";
import { getRecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";

import { createInMemoryDb } from "./helpers/inmemory-db";

const DAY_MS = 24 * 60 * 60 * 1000;

// The composed windowed read model against the seeded demo account.

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
    for (const series of Object.values(w.categorySparkline)) {
      expect(series).toHaveLength(30);
    }
  });
});

describe("getRecoveryDashboardWindow: single-cohort recovery-rate math", () => {
  // Total and recovered come from one cohort, so a rate never exceeds 100%.
  it("recovered never exceeds total, per category and overall, and recoveryRatePct never exceeds 100, across every range", async () => {
    const db = await seededDb();
    for (const range of RECOVERY_RANGES) {
      const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, range, now.getTime());

      expect(w.recoveredCount).toBeLessThanOrEqual(w.totalFailedCount);
      if (w.recoveryRatePct !== null) {
        expect(w.recoveryRatePct).toBeGreaterThanOrEqual(0);
        expect(w.recoveryRatePct).toBeLessThanOrEqual(100);
      }

      for (const category of DECLINE_CATEGORIES) {
        const stat = w.categoryStats[category];
        if (!stat) continue;
        expect(stat.recovered, `${range} ${category}: recovered <= total`).toBeLessThanOrEqual(
          stat.total,
        );
      }

      if (w.bestCategory) {
        expect(w.bestCategory.rate).toBeGreaterThanOrEqual(0);
        expect(w.bestCategory.rate).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("getRecoveryDashboardWindow: daily trend shares the headline's cohort", () => {
  it("recoveries of failures detected before the window never push the daily cumulative rate above 100%, even when they land inside it", async () => {
    const db = await seededDb();
    const range = "7d";
    const oldDetectedAt = new Date(now.getTime() - 40 * DAY_MS); // well before any 7d/30d/90d cutoff
    const recoveredInsideWindow = new Date(now.getTime() - 2 * DAY_MS); // inside every range

    for (let i = 0; i < 8; i++) {
      const id = `test_stale_cohort_failure_${i}`;
      await db.insert(failedPayments).values({
        id,
        stripeEventId: `evt_${id}`,
        stripeInvoiceId: `inv_${id}`,
        stripeCustomerId: `cus_${id}`,
        customerEmail: `${id}@example.com`,
        amountCents: 1000,
        currency: "usd",
        declineCategory: "soft",
        status: "recovered",
        detectedAt: oldDetectedAt,
        resolvedAt: recoveredInsideWindow,
        accountId: DEMO_ACCOUNT_ID,
      });
      await db.insert(recoveredPayments).values({
        id: `test_stale_cohort_recovery_${i}`,
        failedPaymentId: id,
        recoveredAt: recoveredInsideWindow,
        amountCents: 1000,
        currency: "usd",
        recoveryMethod: "foxhound_retry",
        accountId: DEMO_ACCOUNT_ID,
      });
    }

    const w = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, range, now.getTime());
    expect(w.recoveryRateDaily).toHaveLength(7);
    for (const point of w.recoveryRateDaily) {
      if (point.rate !== null) expect(point.rate).toBeLessThanOrEqual(100);
    }
  });
});
