import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// MIGRATION 0019: the unique index on expiring_card_alerts
// (account_id, stripe_customer_id, expires_month, expires_year).
//
// AIMED AT THE MIGRATION, NOT AT schema.ts. The in-memory harness builds
// from the committed migration files, so this fails if the .sql is missing or
// wrong, and passes for no other reason. A plant against the schema object would
// bite nothing, because the database is not built from it.
//
// WHY THE INDEX EXISTS: the subsystem has TWO writers, the
// nightly scan and the customer.updated webhook, and legacy's webhook upserts
// onConflict on exactly this tuple, which only works against a unique index.
// Without it both writers race to insert the same card-month and the merchant's
// customer gets two identical warnings.

let sqlite: Database.Database;

const BASE =
  "INSERT INTO expiring_card_alerts (id, account_id, stripe_customer_id, customer_email, expires_month, expires_year, created_at) VALUES (?, ?, ?, ?, ?, ?, 1000)";

beforeEach(() => {
  ({ sqlite } = createInMemoryDb());
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_1', 'Acme', 1000)").run();
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_2', 'Other', 1000)").run();
});

function insert(id: string, opts: Partial<{ account: string; customer: string; month: number; year: number }> = {}) {
  sqlite
    .prepare(BASE)
    .run(
      id,
      opts.account ?? "acct_1",
      opts.customer ?? "cus_1",
      "buyer@acme.test",
      opts.month ?? 11,
      opts.year ?? 2026,
    );
}

describe("PLANT: the database refuses a duplicate card-month", () => {
  it("the index exists in the schema the MIGRATIONS build", () => {
    const row = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("expiring_card_alerts_card_month_uq") as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toContain("UNIQUE");
    for (const col of ["account_id", "stripe_customer_id", "expires_month", "expires_year"]) {
      expect(row!.sql).toContain(col);
    }
  });

  it("REFUSES the second insert of the same tuple", () => {
    insert("a1");
    expect(() => insert("a2")).toThrow(/UNIQUE constraint failed/);
    const count = sqlite
      .prepare("SELECT count(*) AS c FROM expiring_card_alerts")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("each column is part of the key, so changing any one is a different card-month", () => {
    insert("a1");
    // Four inserts that must all SUCCEED, one per column varied. If the index
    // were narrower than four columns, one of these would be refused.
    insert("a2", { account: "acct_2" });
    insert("a3", { customer: "cus_2" });
    insert("a4", { month: 12 });
    insert("a5", { year: 2027 });
    const count = sqlite
      .prepare("SELECT count(*) AS c FROM expiring_card_alerts")
      .get() as { c: number };
    expect(count.c).toBe(5);
  });

  it("an upsert onto the tuple updates rather than duplicating, which is what the writers need", () => {
    insert("a1");
    sqlite
      .prepare(
        BASE + " ON CONFLICT (account_id, stripe_customer_id, expires_month, expires_year) DO UPDATE SET customer_email = excluded.customer_email",
      )
      .run("a2", "acct_1", "cus_1", "changed@acme.test", 11, 2026);

    const rows = sqlite
      .prepare("SELECT id, customer_email AS email FROM expiring_card_alerts")
      .all() as { id: string; email: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a1");
    expect(rows[0].email).toBe("changed@acme.test");
  });
});
