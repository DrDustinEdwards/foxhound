
import { describe, expect, it } from "vitest";

import { accounts, failedPayments } from "~/db/schema";
import { FAILED_PAYMENT_STATUS_CANCELLED } from "~/lib/constants";
import { tallyStatusCounts } from "~/lib/recovery/queries.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Ruling 262 decision two: "Stop recovery" writes a DISTINCT terminal status,
// `cancelled`, rather than folding into `failed_unrecovered`, because
// operator-terminated and exhausted are different outcomes (Stripe keeps `void`
// and `uncollectible` apart for the same reason).
//
// A fourth status is the kind of change that leaks: every place enumerating the
// other three either grows a branch or silently mishandles the new value. These
// pin the sweep.

const now = new Date("2026-08-12T00:00:00.000Z");

describe("cancelled status: the schema needs no migration to accept it", () => {
  it("stores and reads back a cancelled payment against the committed migrations", () => {
    // MEASURED, and it is why this fold ships no migration: `failed_payments.status`
    // is `text NOT NULL` with NO CHECK constraint (zero CHECK clauses for that
    // table across all committed migrations), so the column already accepts the
    // value. A migration here would have been a no-op with a version number.
    const { sqlite, db } = createInMemoryDb();
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Acme" }));
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id: "fp_1",
        accountId: "acc_1",
        stripeEventId: "evt_1",
        stripeInvoiceId: "in_1",
        stripeCustomerId: "cus_1",
        customerEmail: "customer@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status: FAILED_PAYMENT_STATUS_CANCELLED,
        detectedAt: now,
      }),
    );

    const row = sqlite
      .prepare("select status from failed_payments where id = 'fp_1'")
      .get() as { status: string };
    expect(row.status).toBe("cancelled");
  });
});

describe("cancelled status: counting", () => {
  it("counts cancelled on its own and never folds it into not-recovered", () => {
    const counts = tallyStatusCounts([
      "active",
      "active",
      "recovered",
      "failed_unrecovered",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(counts).toEqual({
      all: 7,
      active: 2,
      recovered: 1,
      failedUnrecovered: 1,
      cancelled: 3,
    });
  });

  it("an unrecognised status still lands in `all` and in no bucket", () => {
    const counts = tallyStatusCounts(["something_new"]);
    expect(counts.all).toBe(1);
    expect(counts.active + counts.recovered + counts.failedUnrecovered + counts.cancelled).toBe(0);
  });
});
