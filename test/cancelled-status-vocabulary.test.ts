import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accounts, failedPayments } from "~/db/schema";
import { FAILED_PAYMENT_STATUS_CANCELLED } from "~/lib/constants";
import { FAILED_PAYMENT_STATUS_LABELS, failedPaymentStatusTone } from "~/lib/recovery/labels";
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
const LIST_ROUTE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");

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

describe("cancelled status: display", () => {
  it("uses legacy's own word, read from its status tabs", () => {
    // legacy app/(app)/recovery/payments/components/PaymentsFilters.tsx:
    //   { key: 'cancelled', label: 'Cancelled' }
    expect(FAILED_PAYMENT_STATUS_LABELS.cancelled).toBe("Cancelled");
  });

  it("renders with a label rather than falling back to the raw column value", () => {
    // The detail and list views both render
    // `FAILED_PAYMENT_STATUS_LABELS[status] ?? status`, so a missing entry would
    // have shipped the bare string "cancelled" to a merchant.
    expect(FAILED_PAYMENT_STATUS_LABELS[FAILED_PAYMENT_STATUS_CANCELLED]).toBeDefined();
  });

  it("REGRESSION GUARD: tone is neutral, matching legacy's subtle treatment", () => {
    // Pre-passing: failedPaymentStatusTone already defaulted unknown statuses to
    // neutral, and legacy renders cancelled as text-subtle. Recorded as a guard,
    // not as proof earned by this fold.
    expect(failedPaymentStatusTone(FAILED_PAYMENT_STATUS_CANCELLED)).toBe("neutral");
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

describe("cancelled status: the list filter", () => {
  it("offers a Cancelled pill, in legacy's tab order", () => {
    // Legacy's STATUS_TABS order: All, Active, Recovered, Cancelled, Failed.
    const pills = LIST_ROUTE.slice(
      LIST_ROUTE.indexOf("const STATUS_PILLS"),
      LIST_ROUTE.indexOf("] as const", LIST_ROUTE.indexOf("const STATUS_PILLS")),
    );
    const order = [...pills.matchAll(/value: "([^"]*)"/g)].map((m) => m[1]);
    expect(order).toEqual(["", "active", "recovered", "cancelled", "failed_unrecovered"]);
  });

  it("each pill reads its own count instead of falling through", () => {
    // The fallthrough `return pillCounts.failedUnrecovered` was harmless while
    // failed_unrecovered was last; with Cancelled inserted before it, the new
    // pill would have displayed the not-recovered total.
    expect(LIST_ROUTE).toContain('if (value === "cancelled") return pillCounts.cancelled;');
  });
});
