import { describe, expect, it } from "vitest";

import { DEMO_ACCOUNT_ID } from "~/lib/demo/constants";
import { seedDemoAccount } from "~/lib/demo/seed";
import { listFilteredFailedPayments } from "~/lib/recovery/queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// TASK-foxhound-demo-system-completion.md Phase 3: /recovery/payments filter
// and sort, entirely in SQL (no client-side pass over the account's full
// payment list), matching the pattern already proven for the Intelligence
// customer directory.

const now = new Date("2026-07-21T00:00:00.000Z");

async function seededDb() {
  const { db } = createInMemoryDb();
  await seedDemoAccount(db, now);
  return db;
}

describe("listFilteredFailedPayments against the seeded demo account", () => {
  it("paginates at 50 per page and totals match the unfiltered count", async () => {
    const db = await seededDb();
    const page1 = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: null,
      declineCategory: null,
      sort: "newest",
      page: 1,
    });
    expect(page1.totalCount).toBe(76);
    expect(page1.payments).toHaveLength(50);
    expect(page1.totalPages).toBe(2);
  });

  it("filters by status", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: "recovered",
      declineCategory: null,
      sort: "newest",
      page: 1,
    });
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.payments.every((p) => p.status === "recovered")).toBe(true);
  });

  it("filters by decline category", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: null,
      declineCategory: "expired",
      sort: "newest",
      page: 1,
    });
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.payments.every((p) => p.declineCategory === "expired")).toBe(true);
  });

  it("finds Acme Industries' scripted failures by name search", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: "Acme",
      status: null,
      declineCategory: null,
      sort: "newest",
      page: 1,
    });
    expect(result.totalCount).toBe(3);
    expect(result.payments.every((p) => p.customerName === "Acme Industries")).toBe(true);
  });

  it("sorts by amount ascending and descending", async () => {
    const db = await seededDb();
    const desc = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: null,
      declineCategory: null,
      sort: "amount_desc",
      page: 1,
    });
    const amounts = desc.payments.map((p) => p.amountCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));

    const asc = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: null,
      declineCategory: null,
      sort: "amount_asc",
      page: 1,
    });
    const ascAmounts = asc.payments.map((p) => p.amountCents);
    expect(ascAmounts).toEqual([...ascAmounts].sort((a, b) => a - b));
  });

  it("sorts oldest-first as the reverse of newest-first", async () => {
    const db = await seededDb();
    const oldest = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: null,
      declineCategory: null,
      sort: "oldest",
      page: 1,
    });
    const dates = oldest.payments.map((p) => p.detectedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("combines filters (status + category) as an AND, not an OR", async () => {
    const db = await seededDb();
    const result = await listFilteredFailedPayments(db, DEMO_ACCOUNT_ID, {
      search: null,
      status: "failed_unrecovered",
      declineCategory: "network",
      sort: "newest",
      page: 1,
    });
    for (const p of result.payments) {
      expect(p.status).toBe("failed_unrecovered");
      expect(p.declineCategory).toBe("network");
    }
  });
});
