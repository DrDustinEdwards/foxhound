import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import {
  getAmountBounds,
  getGlobalPaymentStatusCounts,
  listFailedPayments,
  listPaymentSummaryRows,
} from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-recovery-surface-parity.md Phase 3: the /recovery/payments
// summary read models - amount bounds for the dual-handle range, global
// status counts for the five summary cards, and the filtered-but-not-by-
// status summary rows that back both the status-pill counts and the header
// stats line. All server-computed, never a client-side pass over a page.

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

describe("getAmountBounds", () => {
  it("min is always 0, max is a real ceiling rounded up to the nearest $100", async () => {
    const db = await seededDb();
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    const bounds = await getAmountBounds(db, DEMO_ACCOUNT_ID);
    expect(bounds.minCents).toBe(0);
    const realMax = Math.max(...all.map((p) => p.amountCents));
    expect(bounds.maxCents).toBeGreaterThanOrEqual(realMax);
    expect(bounds.maxCents % 10_000).toBe(0);
  });
});

describe("getGlobalPaymentStatusCounts", () => {
  it("matches a manual tally of every non-noise failed payment, ignoring all filters", async () => {
    const db = await seededDb();
    const all = await listFailedPayments(db, DEMO_ACCOUNT_ID);
    const counts = await getGlobalPaymentStatusCounts(db, DEMO_ACCOUNT_ID);
    expect(counts.all).toBe(all.length);
    expect(counts.active).toBe(all.filter((p) => p.status === "active").length);
    expect(counts.recovered).toBe(all.filter((p) => p.status === "recovered").length);
    expect(counts.failedUnrecovered).toBe(all.filter((p) => p.status === "failed_unrecovered").length);
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
