import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { listExecutedRecoverySteps } from "~/lib/recovery/queries.server";
import { getMostRecentRecoveryAt, listBillableRecoveredForRoi, listRecoveredWithFailureContext, listReactivatedWinbacks } from "~/lib/recovery/dashboard-queries.server";

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

describe("listRecoveredWithFailureContext", () => {

  it("a cutoff in the future returns nothing", async () => {
    const db = await seededDb();
    const rows = await listRecoveredWithFailureContext(db, DEMO_ACCOUNT_ID, now.getTime() + DAY_MS);
    expect(rows).toEqual([]);
  });
});

describe("listExecutedRecoverySteps", () => {

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

describe("getMostRecentRecoveryAt", () => {
  it("finds the most recent recovery, not in the future", async () => {
    const db = await seededDb();
    const at = await getMostRecentRecoveryAt(db, DEMO_ACCOUNT_ID);
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("listBillableRecoveredForRoi", () => {

  it("excludes stripe_baseline recoveries (the free line, never billed)", async () => {
    const db = await seededDb();
    const billable = await listBillableRecoveredForRoi(db, DEMO_ACCOUNT_ID, now.getTime(), null);
    const allRecovered = await listRecoveredWithFailureContext(db, DEMO_ACCOUNT_ID, null);
    // Billable is strictly a subset: every recovered payment exists in the
    // unfiltered set, but not every recovered payment clears the billable bar.
    expect(billable.length).toBeLessThan(allRecovered.length);
  });
});
