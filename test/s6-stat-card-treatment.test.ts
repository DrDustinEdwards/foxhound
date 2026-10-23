import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accounts, failedPayments } from "~/db/schema";
import { recoveryRateValueClass, showingCountFor } from "~/lib/recovery/payments-stats";
import { getGlobalPaymentStatusCounts } from "~/lib/recovery/queries.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S6's LAST two build items, raised by 279 and assigned by 284: the stat-card
// value colours and the Showing card with its pill-responsiveness.
//
// LEGACY IS THE SPEC and was read WHOLE at source rather than inherited from the
// row: app/(app)/recovery/payments/components/PaymentsStats.tsx, blob b386c66,
// 1,249 bytes, and its call site in PaymentsClient.tsx (blob 9404389, 12,701
// bytes). Legacy's five cards and their colorClass values:
//
//   Showing        text-text          <- StatCard's own default, so no prop
//   Active         text-brand-text
//   Recovered      text-green
//   Cancelled      text-text-subtle   <- landed at 352de6a
//   Recovery rate  >=36 text-green, >=21 text-caution (legacy: its accent text), else text-red
//
// TWO INHERITED COUNTS ARE REFUTED HERE, both measured from that read:
//   * 279 and the S6 row say legacy passes colours on FOUR cards and Foxhound on
//     none. Legacy passes one on ALL FIVE, and Foxhound already carried
//     Cancelled's. Showing's legacy colour IS StatCard's default, so it is not a
//     divergence at all. THREE cards were outstanding, not four.
//   * 279 says the Showing item is "the LABEL plus pill-responsiveness". The
//     label and the value mechanism are both real, and there is a THIRD part it
//     did not name: Foxhound carried a `subtext="all filters"` that legacy has
//     no counterpart for. Removing it restores legacy, which is a repair and
//     never a ratified divergence (252).



const now = new Date("2026-08-14T00:00:00.000Z");

function seed(statuses: string[]) {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
  statuses.forEach((status, i) => {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id: `fp_${i}`,
        accountId: "acc_1",
        stripeEventId: `evt_${i}`,
        stripeInvoiceId: `in_${i}`,
        stripeCustomerId: `cus_${i}`,
        customerEmail: "customer@example.com",
        customerName: "Jordan Lee",
        amountCents: 4999,
        currency: "usd",
        declineCategory: "soft",
        declineCode: "insufficient_funds",
        status,
        detectedAt: now,
      }),
    );
  });
  return { sqlite, db };
}

describe("S6 recovery-rate colour: legacy's thresholds, both boundaries inclusive", () => {
  it("36 and above is green", () => {
    expect(recoveryRateValueClass(36)).toBe("text-green");
    expect(recoveryRateValueClass(100)).toBe("text-green");
  });

  it("21 to 35 is caution", () => {
    expect(recoveryRateValueClass(21)).toBe("text-caution");
    expect(recoveryRateValueClass(35)).toBe("text-caution");
  });

  it("below 21 is red", () => {
    expect(recoveryRateValueClass(20)).toBe("text-red");
    expect(recoveryRateValueClass(0)).toBe("text-red");
  });

  it("the boundaries are exactly legacy's, off by one in neither direction", () => {
    // The two cutoffs are the whole content of this port, so they are pinned
    // from both sides. An off-by-one here ships a differently coloured number
    // under an identical-looking card.
    expect(recoveryRateValueClass(35)).not.toBe("text-green");
    expect(recoveryRateValueClass(20)).not.toBe("text-caution");
  });
});

describe("S6 Showing card: legacy's global count, responding only to the pill", () => {
  it("no status filter reads the account total", () => {
    const counts = { all: 10, active: 4, recovered: 3, cancelled: 2, failedUnrecovered: 1 };
    // Foxhound's empty-string sentinel and legacy's literal 'all' are the same
    // pill and both land on the total.
    expect(showingCountFor(counts, "")).toBe(10);
    expect(showingCountFor(counts, "all")).toBe(10);
  });

  it("each pill reads its own global count, never a filtered one", () => {
    const counts = { all: 10, active: 4, recovered: 3, cancelled: 2, failedUnrecovered: 1 };
    expect(showingCountFor(counts, "active")).toBe(4);
    expect(showingCountFor(counts, "recovered")).toBe(3);
    expect(showingCountFor(counts, "cancelled")).toBe(2);
    expect(showingCountFor(counts, "failed_unrecovered")).toBe(1);
  });

  it("an unrecognised status falls back to the total, legacy's own `?? all`", () => {
    // Foxhound's status arrives from the URL, so this branch is reachable by
    // hand-editing a query string. Legacy's index-with-fallback is ported rather
    // than dropped.
    const counts = { all: 10, active: 4, recovered: 3, cancelled: 2, failedUnrecovered: 1 };
    expect(showingCountFor(counts, "nonsense")).toBe(10);
  });

  it("POSITIVE, against the real query: picking Cancelled makes Showing read 2", async () => {
    // Proven against getGlobalPaymentStatusCounts rather than a literal, so what
    // is asserted is the number the card actually renders.
    const { db } = seed(["active", "recovered", "cancelled", "cancelled", "failed_unrecovered"]);
    const counts = await getGlobalPaymentStatusCounts(db, "acc_1");
    expect(showingCountFor(counts, "cancelled")).toBe(2);
    expect(showingCountFor(counts, "")).toBe(5);
  });

  it("it is a GLOBAL count: the card's source query takes no filter input", async () => {
    // 188's refuted half, pinned where it can actually be checked. The card
    // reads getGlobalPaymentStatusCounts, whose signature is (db, accountId):
    // there is no argument by which search, category, date or amount could
    // reach this number, so the card responds to the pill and to nothing else.
    const { db } = seed(["active", "active", "recovered"]);
    const counts = await getGlobalPaymentStatusCounts(db, "acc_1");
    expect(showingCountFor(counts, "active")).toBe(2);
    expect(showingCountFor(counts, "")).toBe(3);
    const queries = readFileSync("app/lib/recovery/queries.server.ts", "utf8");
    expect(queries).toContain(
      "export async function getGlobalPaymentStatusCounts(db: Db, accountId: string)",
    );
  });
});
