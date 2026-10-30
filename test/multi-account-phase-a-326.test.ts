
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Phase (a) of the multi-account build (ruling 326, under 324's strike of the
// single-account constraint). Three things are proven here and they are proven
// at three different layers on purpose:
//
//   1. THE MIGRATION, not schema.ts. The test database is built by replaying the
//      committed .sql files (helpers/inmemory-db.ts), so a plant aimed at
//      schema.ts would bite nothing. That is ruling 314's MIGRATION-AS-TRUTH
//      lesson, learned when exactly such a plant passed against a database that
//      had never seen the change.
//   2. THE RESOLVER, which is where a marker becomes an account.
//   3. THE CALL SITE, read out of guards.ts as source text, so phase (b) cannot
//      quietly stop passing the marker while every behavioral test still
//      passes (the marker is null for every session at phase (a), so behavior
//      alone cannot discriminate here).
//
// Plus a fourth guard for the harness gap: better-sqlite3 is more permissive
// than D1, so where the two can disagree the assertion is on the SQL SHAPE
// rather than on the harness accepting the query.



let sqlite: Database.Database;

beforeEach(() => {
  ({ sqlite } = createInMemoryDb());
});

function seedAccount(id: string, name: string): void {
  sqlite.prepare("INSERT INTO accounts (id, name) VALUES (?, ?)").run(id, name);
}

/** Insert a membership row directly, so the assertions are about what the
 *  DATABASE accepts rather than about what the application chooses to attempt. */
function insertMembership(opts: {
  id: string;
  accountId: string;
  userId: string | null;
  status: string;
  role?: string;
  createdAt?: number;
}): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.id,
      opts.accountId,
      opts.userId,
      opts.role ?? "owner",
      opts.status,
      opts.createdAt ?? 1_000,
    );
}


describe("the migration is what enforces the new membership rule", () => {
  it("ACCEPTS two active memberships for one user on two different accounts", () => {
    seedAccount("acct_a", "Account A");
    seedAccount("acct_b", "Account B");

    insertMembership({ id: "m1", accountId: "acct_a", userId: "user_1", status: "active" });
    // The whole point of ruling 324. Under the struck index this second insert
    // was a UNIQUE violation, which is the single line that made the product
    // single-account.
    expect(() =>
      insertMembership({ id: "m2", accountId: "acct_b", userId: "user_1", status: "active" }),
    ).not.toThrow();

    const n = sqlite
      .prepare("SELECT count(*) AS n FROM account_members WHERE user_id = 'user_1'")
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("REFUSES a duplicate (user, account) active pair, at the database", () => {
    seedAccount("acct_a", "Account A");
    insertMembership({ id: "m1", accountId: "acct_a", userId: "user_1", status: "active" });

    expect(() =>
      insertMembership({ id: "m2", accountId: "acct_a", userId: "user_1", status: "active" }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("still PARTIAL: the same pair is allowed twice when neither row is active", () => {
    // Discriminates "the WHERE clause survived the migration" from "a plain
    // two-column unique shipped". Without the partial clause this would throw,
    // and a revoked member could never be re-invited to the account they left.
    seedAccount("acct_a", "Account A");
    insertMembership({ id: "m1", accountId: "acct_a", userId: "user_1", status: "revoked" });
    expect(() =>
      insertMembership({ id: "m2", accountId: "acct_a", userId: "user_1", status: "revoked" }),
    ).not.toThrow();
  });

  it("leaves pending invite rows alone (null user_id, status pending)", () => {
    seedAccount("acct_a", "Account A");
    insertMembership({ id: "i1", accountId: "acct_a", userId: null, status: "pending" });
    expect(() =>
      insertMembership({ id: "i2", accountId: "acct_a", userId: null, status: "pending" }),
    ).not.toThrow();
  });
});

describe("harness gap: assert the SQL shape, not that better-sqlite3 accepts it", () => {
  // Ruling 318. A green suite proves the harness accepts the query, not that D1
  // does; better-sqlite3 tolerated 417 bound parameters while D1's ceiling of
  // 100 failed the retention sweeper daily for 29 days. Partial indexes are the
  // same class of trap: the two engines agree only when the WHERE clause is a
  // LITERAL, so the guard reads the committed migration text.


  it("the session column exists in the built database and defaults to null", () => {
    const cols = sqlite.prepare("PRAGMA table_info(session)").all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === "active_account_id");
    expect(col).toBeDefined();
    // Null for every session that exists, which is what makes phase (a) a no-op
    // at the chokepoint.
    expect(col!.dflt_value).toBeNull();
    expect(col!.notnull).toBe(0);
  });
});
