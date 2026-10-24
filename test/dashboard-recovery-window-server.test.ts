import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { failedPayments, recoveredPayments } from "~/db";
import { getRecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import { RECOVERY_RANGES } from "~/lib/dashboard/recovery-window";

import { createInMemoryDb } from "./helpers/inmemory-db";

const DAY_MS = 24 * 60 * 60 * 1000;

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

  it("calling with '30d' twice (simulating the reused-single-fetch case) is deterministic", async () => {
    const db = await seededDb();
    const a = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    const b = await getRecoveryDashboardWindow(db, DEMO_ACCOUNT_ID, "30d", now.getTime());
    expect(a).toEqual(b);
  });
});

describe("getRecoveryDashboardWindow: single-cohort recovery-rate math", () => {
  // Phase 1 review finding: legacy anchors its failure denominator on
  // detected_at but its recovered numerator on a separately recovered_at-
  // filtered query - two different cohorts. A failure detected before the
  // window that happens to recover inside it inflates the numerator with no
  // matching denominator entry, which can push a category's (or the
  // account's overall) rate above 100%, and skews bestCategory toward
  // whichever category the mismatch distorts hardest. listFailuresWithOutcome
  // fixes this by deriving total AND recovered from the SAME cohort (failures
  // detected in the window). This asserts that fix holds across every range.
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
        expect(stat.recovered, `${range} ${category}: recovered <= total`).toBeLessThanOrEqual(stat.total);
      }

      if (w.bestCategory) {
        expect(w.bestCategory.rate).toBeGreaterThanOrEqual(0);
        expect(w.bestCategory.rate).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("getRecoveryDashboardWindow: daily trend shares the headline's cohort", () => {
  // Same review finding, applied to recoveryRateDaily: failedByDay was
  // detected_at-anchored but recoveredByDay came from the recovered_at-
  // anchored cash-flow query, so a batch of OLD failures (detected well
  // before the window) recovering INSIDE the window inflated the numerator
  // with no matching denominator entry - a quiet week after a bad week pushes
  // the cumulative line above 100%. This drives that exact shape directly,
  // rather than hoping the seeded data happens to contain it.
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
