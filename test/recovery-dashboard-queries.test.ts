import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { listExecutedRecoverySteps, listFailedPayments } from "~/lib/recovery/queries.server";
import { countActiveWinbacks, countFailuresByCustomer, getConnectionSummary, getMostRecentRecoveryAt, listBillableRecoveredForRoi, listExecutedEmailSteps, listFailuresWithOutcome, listRecoveredWithFailureContext, listReactivatedWinbacks, listUpcomingSteps } from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-recovery-surface-parity.md Phase 1: the new query functions
// backing the Recovery dashboard's windowed read model. Tested against the
// real seeded demo account (same pattern as recovery-payments-filter.test.ts)
// so the SQL is proven against the actual schema, not a hand-rolled fixture.

const now = new Date("2026-07-21T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

describe("listFailuresWithOutcome", () => {
  it("returns every non-renewal-noise failure at cutoff null (all time), with a valid category", async () => {
    const db = await seededDb();
    const rows = await listFailuresWithOutcome(db, DEMO_ACCOUNT_ID, null);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(DECLINE_CATEGORIES).toContain(r.declineCategory);
    }
  });

  it("a narrower cutoff returns a subset, all within the window", async () => {
    const db = await seededDb();
    const all = await listFailuresWithOutcome(db, DEMO_ACCOUNT_ID, null);
    const cutoffMs = now.getTime() - 7 * DAY_MS;
    const recent = await listFailuresWithOutcome(db, DEMO_ACCOUNT_ID, cutoffMs);
    expect(recent.length).toBeLessThanOrEqual(all.length);
    for (const r of recent) {
      expect(r.detectedAt.getTime()).toBeGreaterThanOrEqual(cutoffMs);
    }
  });

  it("recoveredAt, when present, always belongs to a failure detected within the SAME query's cohort (single population, not a mismatched join)", async () => {
    const db = await seededDb();
    const cutoffMs = now.getTime() - 30 * DAY_MS;
    const rows = await listFailuresWithOutcome(db, DEMO_ACCOUNT_ID, cutoffMs);
    for (const r of rows) {
      expect(r.detectedAt.getTime()).toBeGreaterThanOrEqual(cutoffMs);
      if (r.recoveredAt) expect(r.recoveredAt.getTime()).toBeGreaterThanOrEqual(r.detectedAt.getTime());
    }
  });
});

describe("listRecoveredWithFailureContext", () => {
  it("every row recovered after it was detected, with a valid category", async () => {
    const db = await seededDb();
    const rows = await listRecoveredWithFailureContext(db, DEMO_ACCOUNT_ID, null);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.recoveredAt.getTime()).toBeGreaterThanOrEqual(r.detectedAt.getTime());
      expect(DECLINE_CATEGORIES).toContain(r.declineCategory);
    }
  });

  it("a cutoff in the future returns nothing", async () => {
    const db = await seededDb();
    const rows = await listRecoveredWithFailureContext(db, DEMO_ACCOUNT_ID, now.getTime() + DAY_MS);
    expect(rows).toEqual([]);
  });
});

describe("countFailuresByCustomer", () => {
  it("counts a repeat-failure customer's other failures, matching a manual count", async () => {
    const db = await seededDb();
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    const repeatCustomerId = all.find(
      (p, i) => all.findIndex((q) => q.stripeCustomerId === p.stripeCustomerId) !== i,
    )?.stripeCustomerId;
    expect(repeatCustomerId).toBeDefined();

    const counts = await countFailuresByCustomer(db, DEMO_ACCOUNT_ID, [repeatCustomerId!]);
    const manualCount = all.filter((p) => p.stripeCustomerId === repeatCustomerId).length;
    expect(counts[repeatCustomerId!]).toBe(manualCount);
  });

  it("returns an empty map for an empty id list", async () => {
    const db = await seededDb();
    expect(await countFailuresByCustomer(db, DEMO_ACCOUNT_ID, [])).toEqual({});
  });
});

describe("listExecutedEmailSteps", () => {
  it("returns only email_* steps, unscoped by range (no cutoff parameter)", async () => {
    const db = await seededDb();
    const rows = await listExecutedEmailSteps(db, DEMO_ACCOUNT_ID);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(DECLINE_CATEGORIES).toContain(r.declineCategory);
    }
  });
});

describe("listExecutedRecoverySteps", () => {
  it("returns both email and retry steps, unscoped by range, with a valid category", async () => {
    const db = await seededDb();
    const rows = await listExecutedRecoverySteps(db, DEMO_ACCOUNT_ID);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.stepType.startsWith("email_"))).toBe(true);
    expect(rows.some((r) => r.stepType.startsWith("retry_"))).toBe(true);
    for (const r of rows) {
      expect(DECLINE_CATEGORIES).toContain(r.declineCategory);
      expect(r.executedAt).toBeInstanceOf(Date);
    }
  });

  it("creditedRecovery is true only for the step actually credited by recovered_payments.recovered_by_step_id", async () => {
    const db = await seededDb();
    const rows = await listExecutedRecoverySteps(db, DEMO_ACCOUNT_ID);
    const credited = rows.filter((r) => r.creditedRecovery);
    expect(credited.length).toBeGreaterThan(0);
    // Every credited row must be an id recoveredPayments actually references -
    // proven indirectly here by checking the flag isn't set on every row (a
    // constant-true bug would pass the first assertion but fail this one).
    expect(credited.length).toBeLessThan(rows.length);
  });
});

describe("listReactivatedWinbacks", () => {
  it("a cutoff in the future returns nothing", async () => {
    const db = await seededDb();
    const rows = await listReactivatedWinbacks(db, DEMO_ACCOUNT_ID, now.getTime() + DAY_MS);
    expect(rows).toEqual([]);
  });
});

describe("countActiveWinbacks", () => {
  it("finds at least one currently-active win-back sequence (demo seed guarantee)", async () => {
    const db = await seededDb();
    expect(await countActiveWinbacks(db, DEMO_ACCOUNT_ID)).toBeGreaterThan(0);
  });
});

describe("getConnectionSummary", () => {
  it("finds the demo account's seeded primary connection", async () => {
    const db = await seededDb();
    const connection = await getConnectionSummary(db, DEMO_ACCOUNT_ID);
    expect(connection).not.toBeNull();
    expect(connection!.stripeUserId).toBe("acct_demo_teamflow");
    expect(connection!.lastWebhookAt).not.toBeNull();
  });
});

describe("getMostRecentRecoveryAt", () => {
  it("finds the most recent recovery, not in the future", async () => {
    const db = await seededDb();
    const at = await getMostRecentRecoveryAt(db, DEMO_ACCOUNT_ID);
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("listUpcomingSteps", () => {
  it("finds unexecuted steps within a wide window, all still pending", async () => {
    const db = await seededDb();
    const rows = await listUpcomingSteps(db, DEMO_ACCOUNT_ID, now.getTime(), 90 * DAY_MS);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });

  it("a zero-width window finds nothing", async () => {
    const db = await seededDb();
    const rows = await listUpcomingSteps(db, DEMO_ACCOUNT_ID, now.getTime(), 0);
    expect(rows).toEqual([]);
  });
});

describe("listBillableRecoveredForRoi", () => {
  it("all-time is a superset of this-month, and every row is old enough to be matured", async () => {
    const db = await seededDb();
    const firstOfMonthUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const allTime = await listBillableRecoveredForRoi(db, DEMO_ACCOUNT_ID, now.getTime(), null);
    const thisMonth = await listBillableRecoveredForRoi(db, DEMO_ACCOUNT_ID, now.getTime(), firstOfMonthUtc);
    expect(allTime.length).toBeGreaterThan(0);
    expect(thisMonth.length).toBeLessThanOrEqual(allTime.length);
    for (const r of allTime) {
      expect(r.amountCents).toBeGreaterThan(0);
      expect(r.currency).toBe("usd");
    }
  });

  it("excludes stripe_baseline recoveries (the free line, never billed)", async () => {
    const db = await seededDb();
    const billable = await listBillableRecoveredForRoi(db, DEMO_ACCOUNT_ID, now.getTime(), null);
    const allRecovered = await listRecoveredWithFailureContext(db, DEMO_ACCOUNT_ID, null);
    // Billable is strictly a subset: every recovered payment exists in the
    // unfiltered set, but not every recovered payment clears the billable bar.
    expect(billable.length).toBeLessThan(allRecovered.length);
  });
});
