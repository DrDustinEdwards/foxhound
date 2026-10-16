import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accounts, failedPayments } from "~/db/schema";
import { buildPaymentsCsv } from "~/lib/recovery/payments-csv";
import { FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { getGlobalPaymentStatusCounts } from "~/lib/recovery/queries.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S6's last two build items: the stat-card Cancelled gap (266) and the two
// RENAMED status values, which S6's row has carried as OPEN since the contents
// walk and which 278 left open again.
//
// THE PRECONDITION, checked rather than assumed: PRIME DIRECTIVE item 3 was read
// in full and carries NO ratification of "In recovery" or "Not recovered", and
// no ruling in VOL2 through VOL6 ratifies them either. Under item 3 an
// unratified user-visible divergence is corrected toward legacy rather than
// defended, so legacy's own words are the spec here.
//
// LEGACY'S WORDS, read at source rather than inherited from the row:
//   PaymentsFilters.tsx STATUS_TABS -> All / Active / Recovered / Cancelled / Failed
//   PaymentsStats.tsx cards         -> Showing / Active / Recovered / Cancelled / Recovery rate
//
// LEGACY DISAGREES WITH ITSELF and that is recorded rather than harmonised
// (275): its list-row badge and its detail badge both render `{payment.status}`
// raw under CSS `capitalize`, so legacy's BADGES read "Active", "Recovered",
// "Cancelled" and "Failed_unrecovered" while its PILLS read "Failed". Foxhound
// maps every surface through one label table, so its badge reads "Failed" where
// legacy's would read the underscored column value. That last difference is
// REPORTED, not ported: shipping a database enum to a merchant is a defect, and
// the direction of that fix is a ruling rather than a build session's default.

const LIST_ROUTE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");
const DETAIL_ROUTE = readFileSync("app/routes/app/recovery/payments/detail.tsx", "utf8");

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

describe("S6 status labels: legacy's words, because none of the renames was ratified", () => {
  it("the label table reads Active and Failed, legacy's own status-tab words", () => {
    expect(FAILED_PAYMENT_STATUS_LABELS.active).toBe("Active");
    expect(FAILED_PAYMENT_STATUS_LABELS.failed_unrecovered).toBe("Failed");
    // Untouched by this fold, and asserted so a sweep of two values cannot
    // quietly move a third.
    expect(FAILED_PAYMENT_STATUS_LABELS.recovered).toBe("Recovered");
    expect(FAILED_PAYMENT_STATUS_LABELS.cancelled).toBe("Cancelled");
  });

  it("the renamed strings survive in no rendered value and on no route", () => {
    // Asserted on the map VALUES, not on labels.ts source: that file records
    // what the strings USED to be and why they moved, which a source matcher
    // would read as a survival. The matcher was wrong the first time, not the
    // code (239).
    const rendered = Object.values(FAILED_PAYMENT_STATUS_LABELS);
    expect(rendered).not.toContain("In recovery");
    expect(rendered).not.toContain("Not recovered");
    for (const source of [LIST_ROUTE, DETAIL_ROUTE]) {
      expect(source).not.toContain("In recovery");
      expect(source).not.toContain("Not recovered");
    }
  });

  it("the filter pills are legacy's five labels in legacy's tab order", () => {
    // Legacy PaymentsFilters.tsx STATUS_TABS, read at blob b6612fa.
    const pills = LIST_ROUTE.slice(
      LIST_ROUTE.indexOf("const STATUS_PILLS = ["),
      LIST_ROUTE.indexOf("] as const;", LIST_ROUTE.indexOf("const STATUS_PILLS = [")),
    );
    const labels = [...pills.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["All", "Active", "Recovered", "Cancelled", "Failed"]);
  });
});

describe("S6 status labels: every surface the label table feeds", () => {
  // The blast radius was MEASURED before anything changed: three render
  // surfaces, named here so a future reader does not have to re-derive them.
  it("the list table badge renders through the shared table, not its own string", () => {
    expect(LIST_ROUTE).toContain("FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status");
  });

  it("the detail badge renders through the same table", () => {
    expect(DETAIL_ROUTE).toContain(
      "FAILED_PAYMENT_STATUS_LABELS[failedPayment.status] ?? failedPayment.status",
    );
  });

  it("the CSV export carries legacy's word too, though it has NO legacy counterpart", () => {
    // S12 is NET-NEW: legacy ships no CSV export, so there is no legacy string
    // to match here. It is listed because it consumes the same table and this
    // fold changed what it emits, which is a reported consequence rather than a
    // parity claim.
    const csv = buildPaymentsCsv(
      [
        {
          customerName: "Jordan Lee",
          customerEmail: "jordan@example.com",
          planName: "Growth",
          amountCents: 4999,
          currency: "usd",
          declineCategory: "soft",
          declineCode: "insufficient_funds",
          status: "active",
          detectedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ] as Parameters<typeof buildPaymentsCsv>[0],
    );
    expect(csv).toContain(",Active,");
    expect(csv).not.toContain("In recovery");
  });
});

describe("S6 stat cards: legacy's five, with Cancelled restored (266)", () => {
  function cardBlock() {
    // J75: the five cards are one array the page maps onto Capsomer panels.
    const start = LIST_ROUTE.indexOf("const cards: { label: string;");
    return LIST_ROUTE.slice(start, LIST_ROUTE.indexOf("];", start));
  }

  it("renders legacy's card set, in legacy's order", () => {
    // Legacy PaymentsStats.tsx at blob b386c66, read whole: Showing / Active /
    // Recovered / Cancelled / Recovery rate. Foxhound's first card keeps its own
    // label, which is a separately recorded and still-open divergence (188) that
    // this fold does not touch.
    const labels = [...cardBlock().matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    // UPDATED 2026-08-14 under 284's Session 1: this expected "Total payments"
    // in position one and the comment above called the label "a separately
    // recorded and still-open divergence (188) that this fold does not touch".
    // 279 corrected 188 and 284 assigned the card, so position one is now
    // legacy's own word. The old expectation is REPLACED rather than annotated
    // around, since a test pinning a superseded state is the same stale-record
    // class the campaign repairs everywhere else.
    expect(labels).toEqual([
      "Showing",
      "Active",
      "Recovered",
      "Cancelled",
      "Recovery rate",
    ]);
  });

  it("the fourth card is Cancelled and reads the cancelled count", () => {
    // 266's gap in one line: the pill counted a cancelled payment and no card
    // did. The card that occupied this position had no legacy counterpart at
    // all, so under item 3's inverse corollary (112) it is a Foxhound addition
    // being corrected toward legacy rather than a feature being lost.
    // The element is multi-line, so the assertion reads the two attributes
    // rather than one flattened line: a single-line matcher failed here against
    // correct code, which is the same class as the one above (239).
    expect(cardBlock()).toContain('label: "Cancelled"');
    expect(cardBlock()).toContain("value: String(globalCounts.cancelled)");
    // The card that stood here is gone, not merely relabelled.
    expect(cardBlock()).not.toContain("failedUnrecovered");
  });

  it("carries legacy's own muted treatment for this card", () => {
    // PaymentsStats gives Cancelled `text-text-subtle`. The remaining value
    // colours were reported by that fold and are CLOSED 2026-08-14 under 284;
    // they are asserted in test/s6-stat-card-treatment.test.ts.
    expect(cardBlock()).toContain('className: "text-text-subtle"');
  });

  it("adds NO query shape: the count already existed on globalCounts", () => {
    // tallyStatusCounts has counted `cancelled` since Session B (265), and
    // getGlobalPaymentStatusCounts returns it. The gap was never a missing
    // number; it was a missing card.
    const { db } = seed(["active", "recovered", "cancelled", "cancelled", "failed_unrecovered"]);
    return getGlobalPaymentStatusCounts(db, "acc_1").then((counts) => {
      expect(counts.cancelled).toBe(2);
      expect(counts.all).toBe(5);
    });
  });

  it("POSITIVE: one cancelled payment makes the card read 1", async () => {
    // The brief's own proof: insert a cancelled payment, the card's value is 1.
    // Asserted against the real query rather than a stub, so what is proven is
    // the number the card renders.
    const { db } = seed(["cancelled"]);
    const counts = await getGlobalPaymentStatusCounts(db, "acc_1");
    expect(String(counts.cancelled)).toBe("1");
  });
});
