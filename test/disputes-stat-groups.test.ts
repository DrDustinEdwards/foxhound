import { describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { disputes } from "~/db";
import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { SUBMITTED_EXTERNALLY } from "~/lib/disputes/labels";
import { disputeStatGroups } from "~/lib/disputes/queries.server";
import { computeDisputeStats, computeDisputeStatsFromGroups } from "~/lib/disputes/stats";
import { groupSumByCurrency } from "~/lib/money/totals";

import { createInMemoryDb } from "./helpers/inmemory-db";

// /disputes counts its cards in SQL (disputeStatGroups) instead of reading every
// dispute. The SQL decides "submitted by Foxhound" on its own, so it is held to
// the row-by-row computation the preview and the audit figures use.

describe("disputeStatGroups", () => {
  it("gives the same cards as computing them over every row", async () => {
    const { db } = createInMemoryDb();
    await seedDemoAccount(db, new Date("2026-07-21T00:00:00.000Z"));
    // One submitted dispute marked as sent by someone else, one with no sender.
    const seeded = await db.select().from(disputes).where(eq(disputes.accountId, DEMO_ACCOUNT_ID));
    const submitted = seeded.filter((d) => d.submittedAt !== null);
    expect(submitted.length).toBeGreaterThan(1);
    await db
      .update(disputes)
      .set({ submittedBy: SUBMITTED_EXTERNALLY })
      .where(eq(disputes.id, submitted[0].id));
    await db.update(disputes).set({ submittedBy: null }).where(eq(disputes.id, submitted[1].id));
    const mine = await db.select().from(disputes).where(eq(disputes.accountId, DEMO_ACCOUNT_ID));

    const fromRows = computeDisputeStats(mine);
    const fromGroups = computeDisputeStatsFromGroups(await disputeStatGroups(db, DEMO_ACCOUNT_ID));
    expect({ ...fromGroups, atStakeParts: groupSumByCurrency(fromGroups.atStakeParts) }).toEqual({
      ...fromRows,
      atStakeParts: groupSumByCurrency(fromRows.atStakeParts),
    });
  });
});
