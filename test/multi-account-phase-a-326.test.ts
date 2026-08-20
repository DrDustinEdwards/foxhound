import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { listMemberships, resolveActiveMembership, resolveMembership } from "~/lib/auth/account";

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
//      quietly stop passing the marker while every behavioural test still
//      passes (the marker is null for every session at phase (a), so behaviour
//      alone cannot discriminate here).
//
// Plus a fourth guard for the harness gap: better-sqlite3 is more permissive
// than D1, so where the two can disagree the assertion is on the SQL SHAPE
// rather than on the harness accepting the query (ruling 318).

const OLD_INDEX = "account_members_one_active_per_user_uq";
const NEW_INDEX = "account_members_user_account_active_uq";

const MIGRATION_0018 = fileURLToPath(
  new URL("../drizzle/migrations/0018_wakeful_gamma_corps.sql", import.meta.url),
);

let sqlite: Database.Database;
let db: Db;

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
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

function indexNames(): string[] {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_members'")
    .all()
    .map((r) => (r as { name: string }).name);
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

  it("the OLD index name is ABSENT from sqlite_master and the NEW one is present", () => {
    const names = indexNames();
    expect(names).not.toContain(OLD_INDEX);
    expect(names).toContain(NEW_INDEX);
    // Calibration: prove the query reads real rows, so "absent" cannot be an
    // empty result set masquerading as a result (ruling 259's data-dependent
    // zero, and 313's rule that a non-result is not a result).
    expect(names).toContain("account_members_account_idx");
  });
});

describe("resolveActiveMembership turns a session marker into an account", () => {
  function seedTwoAccounts(): void {
    seedAccount("acct_a", "Account A");
    seedAccount("acct_b", "Account B");
    insertMembership({
      id: "m1",
      accountId: "acct_a",
      userId: "user_1",
      status: "active",
      createdAt: 1_000,
    });
    insertMembership({
      id: "m2",
      accountId: "acct_b",
      userId: "user_1",
      status: "active",
      role: "member",
      createdAt: 2_000,
    });
  }

  it("marker null resolves the EARLIEST membership", async () => {
    seedTwoAccounts();
    const m = await resolveActiveMembership(db, "user_1", null);
    expect(m?.accountId).toBe("acct_a");
  });

  it("marker matching a held membership resolves THAT one", async () => {
    seedTwoAccounts();
    const m = await resolveActiveMembership(db, "user_1", "acct_b");
    expect(m?.accountId).toBe("acct_b");
    expect(m?.role).toBe("member");
  });

  it("marker for an account the user does NOT hold falls back, and does not throw", async () => {
    seedTwoAccounts();
    seedAccount("acct_c", "Someone else's account");
    const m = await resolveActiveMembership(db, "user_1", "acct_c");
    expect(m?.accountId).toBe("acct_a");
  });

  it("marker for an account the user holds as REVOKED falls back, and does not throw", async () => {
    seedTwoAccounts();
    seedAccount("acct_r", "Revoked account");
    insertMembership({
      id: "m3",
      accountId: "acct_r",
      userId: "user_1",
      status: "revoked",
      createdAt: 3_000,
    });
    // The case an ON DELETE SET NULL foreign key could never have caught: the
    // account still exists, the row still exists, and the membership is gone.
    const m = await resolveActiveMembership(db, "user_1", "acct_r");
    expect(m?.accountId).toBe("acct_a");
  });

  it("marker for an account id that does not exist at all falls back", async () => {
    seedTwoAccounts();
    const m = await resolveActiveMembership(db, "user_1", "acct_deleted");
    expect(m?.accountId).toBe("acct_a");
  });

  it("a user with no membership resolves null, with or without a marker", async () => {
    seedAccount("acct_a", "Account A");
    expect(await resolveActiveMembership(db, "nobody", null)).toBeNull();
    expect(await resolveActiveMembership(db, "nobody", "acct_a")).toBeNull();
  });

  it("listMemberships returns every active membership, earliest first", async () => {
    seedTwoAccounts();
    const all = await listMemberships(db, "user_1");
    expect(all.map((m) => m.accountId)).toEqual(["acct_a", "acct_b"]);
  });

  it("listMemberships excludes non-active rows", async () => {
    seedTwoAccounts();
    seedAccount("acct_r", "Revoked account");
    insertMembership({
      id: "m3",
      accountId: "acct_r",
      userId: "user_1",
      status: "revoked",
      createdAt: 3_000,
    });
    const all = await listMemberships(db, "user_1");
    expect(all.map((m) => m.accountId)).toEqual(["acct_a", "acct_b"]);
  });

  it("the resolveMembership shim is exactly the null-marker case", async () => {
    // Phase (a) ships no behaviour change for the six callers that still use the
    // shim (theme read/write, the marketing layout, the connect pair). This is
    // that promise as an assertion rather than as a comment.
    seedTwoAccounts();
    const shim = await resolveMembership(db, "user_1");
    const explicit = await resolveActiveMembership(db, "user_1", null);
    expect(shim).toEqual(explicit);
    expect(shim?.accountId).toBe("acct_a");
  });
});

describe("the guards.ts chokepoint passes the session marker", () => {
  const GUARDS = fileURLToPath(new URL("../app/lib/auth/guards.ts", import.meta.url));

  it("appShellMiddleware calls resolveActiveMembership with session.session.activeAccountId", () => {
    const source = readFileSync(GUARDS, "utf8");

    // Scoped to the CALL, never to the import line: an assertion that matches
    // `import { resolveActiveMembership }` would pass against a call site that
    // had stopped using it entirely (ruling 316's vacuous-assertion catch).
    const call = source.match(/resolveActiveMembership\(([\s\S]*?)\);/);
    expect(call).not.toBeNull();

    const args = call![1];
    expect(args).toContain("session.user.id");
    expect(args).toContain("session.session.activeAccountId");
    // A hardcoded null in the third position is the exact regression this guard
    // exists to catch: it type-checks, it keeps every behavioural test green
    // (the marker is null everywhere at phase (a)), and it silently disables
    // account switching the moment phase (b) ships a writer.
    expect(args).not.toMatch(/,\s*null\s*,?\s*$/);
  });

  it("guards.ts no longer imports the pre-326 resolver", () => {
    const source = readFileSync(GUARDS, "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*\bresolveMembership\b/);
  });
});

describe("harness gap: assert the SQL shape, not that better-sqlite3 accepts it", () => {
  // Ruling 318. A green suite proves the harness accepts the query, not that D1
  // does; better-sqlite3 tolerated 417 bound parameters while D1's ceiling of
  // 100 failed the retention sweeper daily for 29 days. Partial indexes are the
  // same class of trap: the two engines agree only when the WHERE clause is a
  // LITERAL, so the guard reads the committed migration text.
  const sql = () => readFileSync(MIGRATION_0018, "utf8");

  function createStatement(): string {
    const line = sql()
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => s.startsWith("CREATE UNIQUE INDEX"));
    expect(line).toBeDefined();
    return line!;
  }

  it("the CREATE UNIQUE INDEX carries a placeholder-free, literal partial WHERE", () => {
    const statement = createStatement();
    expect(statement).toContain(NEW_INDEX);
    expect(statement).toMatch(/ON `account_members` \(`user_id`,`account_id`\)/);
    expect(statement).toMatch(/WHERE\s+"account_members"\."status"\s*=\s*'active'/);
    // No bound parameter anywhere. A parameterised partial index is not a thing
    // SQLite will accept, and the failure mode is a migration that dies on the
    // production apply after passing every local test.
    expect(statement).not.toContain("?");
  });

  it("the migration drops the struck index by name, and adds the session column", () => {
    const statements = sql()
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements.some((s) => s === `DROP INDEX \`${OLD_INDEX}\`;`)).toBe(true);
    // ADD COLUMN rather than a table rebuild: SQLite cannot add a column with a
    // non-constant default, and drizzle-kit falls back to recreating the table
    // when it has to, which on `session` would drop every live login.
    expect(
      statements.some((s) => /^ALTER TABLE `session` ADD `active_account_id` text;?$/.test(s)),
    ).toBe(true);
    expect(statements.some((s) => /CREATE TABLE `__new_session`/.test(s))).toBe(false);
    expect(statements).toHaveLength(3);
  });

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
