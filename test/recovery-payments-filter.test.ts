import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { listFilteredFailedPayments, type FailedPaymentFilters } from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-demo-system-completion.md Phase 3: /recovery/payments filter
// and sort, entirely in SQL (no client-side pass over the account's full
// payment list), matching the pattern already proven for the Intelligence
// customer directory. Extended in TASK-foxhound-recovery-surface-parity.md
// Phase 3 with amount range, a detected-after cutoff, and configurable page
// size; see recovery-dashboard-payments-summary.test.ts for those additions.

const now = new Date("2026-07-21T00:00:00.000Z");

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

const BASE_FILTERS: FailedPaymentFilters = {
  search: null,
  status: null,
  declineCategory: null,
  detectedAfterMs: null,
  amountMinCents: null,
  amountMaxCents: null,
  sort: "newest",
  page: 1,
  pageSize: 50,
};

describe("listFilteredFailedPayments against the seeded demo account", () => {

  it("finds Acme Industries' scripted failures by name search", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, { ...BASE_FILTERS, search: "Acme" });
    expect(result.totalCount).toBe(3);
    expect(result.payments.every((p) => p.customerName === "Acme Industries")).toBe(true);
  });

  it("sorts by amount ascending and descending", async () => {
    const db = await seededDb();
    const desc = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, { ...BASE_FILTERS, sort: "amount_desc" });
    const amounts = desc.payments.map((p) => p.amountCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));

    const asc = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, { ...BASE_FILTERS, sort: "amount_asc" });
    const ascAmounts = asc.payments.map((p) => p.amountCents);
    expect(ascAmounts).toEqual([...ascAmounts].sort((a, b) => a - b));
  });

  it("sorts oldest-first as the reverse of newest-first", async () => {
    const db = await seededDb();
    const oldest = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, { ...BASE_FILTERS, sort: "oldest" });
    const dates = oldest.payments.map((p) => p.detectedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("combines filters (status + category) as an AND, not an OR", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      ...BASE_FILTERS,
      status: "failed_unrecovered",
      declineCategory: "network",
    });
    for (const p of result.payments) {
      expect(p.status).toBe("failed_unrecovered");
      expect(p.declineCategory).toBe("network");
    }
  });

  it("filters by amount range", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      ...BASE_FILTERS,
      amountMinCents: 10_000,
      amountMaxCents: 20_000,
    });
    expect(result.totalCount).toBeGreaterThan(0);
    for (const p of result.payments) {
      expect(p.amountCents).toBeGreaterThanOrEqual(10_000);
      expect(p.amountCents).toBeLessThanOrEqual(20_000);
    }
  });

  it("filters by a detected-after cutoff", async () => {
    const db = await seededDb();
    const cutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      ...BASE_FILTERS,
      detectedAfterMs: cutoffMs,
    });
    expect(result.totalCount).toBeGreaterThan(0);
    for (const p of result.payments) {
      expect(p.detectedAt.getTime()).toBeGreaterThanOrEqual(cutoffMs);
    }
  });
});
