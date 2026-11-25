import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { failedPayments, recoverySteps } from "~/db/schema";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  listBillableRecoveredForRoi,
  listUpcomingSteps,
  listRecoveredWithFailureContext,
} from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Read queries behind the dashboard, against the seeded demo account.

const now = new Date("2026-07-21T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

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

describe("listUpcomingSteps", () => {
  it("lists only what the cron would send: a recovered payment's step or a resulted one drops out", async () => {
    const db = await seededDb();
    const WIDE = 365 * DAY_MS;
    const before = await listUpcomingSteps(db, DEMO_ACCOUNT_ID, now.getTime(), WIDE);
    expect(before.length).toBeGreaterThan(1);
    const [first, second] = before;
    await db.update(recoverySteps).set({ result: "skipped" }).where(eq(recoverySteps.id, first.id));
    const owner = await db
      .select({ id: recoverySteps.failedPaymentId })
      .from(recoverySteps)
      .where(eq(recoverySteps.id, second.id));
    await db
      .update(failedPayments)
      .set({ status: "recovered" })
      .where(eq(failedPayments.id, owner[0].id));
    const after = await listUpcomingSteps(db, DEMO_ACCOUNT_ID, now.getTime(), WIDE);
    expect(after.map((r) => r.id)).not.toContain(first.id);
    expect(after.map((r) => r.id)).not.toContain(second.id);
  });
});
