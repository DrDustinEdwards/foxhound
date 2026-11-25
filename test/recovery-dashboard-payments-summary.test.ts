import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  getGlobalPaymentStatusCounts,
  listFailedPayments,
  listPaymentSummaryRows,
} from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The /recovery/payments summary read models, against the seeded demo account.

const now = new Date("2026-07-21T00:00:00.000Z");

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

const NO_FILTERS = {
  search: null,
  declineCategory: null,
  detectedAfterMs: null,
  amountMinCents: null,
  amountMaxCents: null,
};

describe("getGlobalPaymentStatusCounts", () => {
  it("matches a manual tally of every non-noise failed payment, ignoring all filters", async () => {
    const db = await seededDb();
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    const counts = await getGlobalPaymentStatusCounts(db, DEMO_ACCOUNT_ID);
    expect(counts.all).toBe(all.length);
    expect(counts.active).toBe(all.filter((p) => p.status === "active").length);
    expect(counts.recovered).toBe(all.filter((p) => p.status === "recovered").length);
    expect(counts.failedUnrecovered).toBe(
      all.filter((p) => p.status === "failed_unrecovered").length,
    );
  });
});

describe("listPaymentSummaryRows", () => {
  it("respects declineCategory, so pill counts reflect the OTHER active filters", async () => {
    const db = await seededDb();
    const rows = await listPaymentSummaryRows(db, DEMO_ACCOUNT_ID, {
      ...NO_FILTERS,
      declineCategory: "expired",
    });
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    const manualCount = all.filter((p) => p.declineCategory === "expired").length;
    expect(rows).toHaveLength(manualCount);
  });
});
