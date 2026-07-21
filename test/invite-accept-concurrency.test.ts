import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accountMembers, accounts } from "~/db/schema";
import { acceptInvite, createAccountForUser } from "~/lib/auth/account";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Cross-tenant regression for account-scoping audit MEDIUM #4: acceptInvite is a
// read-then-write (check the user has no active membership, then activate the
// invite row). Two concurrent accepts of two different invites can both read
// "no membership" before either commits, so the read alone cannot enforce the
// single-account invariant. The account_members_one_active_per_user_uq partial
// unique index is the structural guard, and acceptInvite maps the rejected write
// back to already_member. Proven against a REAL in-memory SQLite with the
// committed migrations applied, so the index (not a SQL-shape assertion) is what
// stops the second membership.

const now = new Date("2026-07-20T00:00:00.000Z");
const USER = "user_1";
const EMAIL = "teammate@acme.com";

/** One user, two accounts, two pending invites (tok_A -> acc_A, tok_B -> acc_B). */
function seedTwoInvites() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_A", name: "Acme A" }));
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_B", name: "Acme B" }));
  for (const [id, accountId, token] of [
    ["mem_A", "acc_A", "tok_A"],
    ["mem_B", "acc_B", "tok_B"],
  ] as const) {
    runStatement(
      sqlite,
      db.insert(accountMembers).values({
        id,
        accountId,
        userId: null,
        role: MEMBER_ROLE.MEMBER,
        invitedEmail: EMAIL,
        status: MEMBER_STATUS.PENDING,
        inviteToken: token,
        // Unexpired relative to the real wall clock getInviteByToken reads.
        inviteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: now,
      }),
    );
  }
  return { sqlite, db };
}

function activeMemberships(db: Db) {
  return db
    .select({ id: accountMembers.id, accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.userId, USER), eq(accountMembers.status, MEMBER_STATUS.ACTIVE)),
    );
}

// createAccountForUser uses db.batch(), a D1 primitive the better-sqlite3 driver
// does not implement. Supply a faithful atomic batch: sqlite.transaction rolls
// the whole batch back if any statement throws (a UNIQUE violation), matching
// D1's all-or-nothing semantics, so the no-orphan-account assertion is real.
function withAtomicBatch(sqlite: Parameters<typeof runStatement>[0], db: Db): Db {
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return (stmts: unknown[]) => {
          sqlite.transaction((list: unknown[]) => {
            for (const s of list) runStatement(sqlite, s);
          })(stmts);
          return Promise.resolve([]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describe("MEDIUM #4: concurrent invite acceptance cannot land two active memberships", () => {
  it("a single accept activates the invite and clears the token (no regression)", async () => {
    const { db } = seedTwoInvites();

    const result = await acceptInvite(db, "tok_A", USER, EMAIL);

    expect(result).toEqual({ ok: true, accountId: "acc_A" });
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(active[0].accountId).toBe("acc_A");
    const row = await db
      .select({ token: accountMembers.inviteToken, status: accountMembers.status })
      .from(accountMembers)
      .where(eq(accountMembers.id, "mem_A"));
    expect(row[0].token).toBeNull();
    expect(row[0].status).toBe(MEMBER_STATUS.ACTIVE);
  });

  it("two concurrent accepts yield exactly one active membership (the DB rejects the second)", async () => {
    const { sqlite, db } = seedTwoInvites();

    // Racer A wins and commits its activation.
    const a = await acceptInvite(db, "tok_A", USER, EMAIL);
    expect(a.ok).toBe(true);

    // Racer B already passed its existing-membership read (null, captured before
    // A committed), so it proceeds straight to activation. Its UPDATE is the
    // exact statement acceptInvite issues; the unique index must reject it.
    const bWrite = db
      .update(accountMembers)
      .set({
        userId: USER,
        status: MEMBER_STATUS.ACTIVE,
        inviteToken: null,
        inviteExpiresAt: null,
      })
      .where(eq(accountMembers.id, "mem_B"));
    expect(() => runStatement(sqlite, bWrite)).toThrow(/unique constraint/i);

    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(active[0].accountId).toBe("acc_A");
  });

  it("acceptInvite that loses the race returns already_member instead of throwing", async () => {
    const { sqlite, db } = seedTwoInvites();

    // Reproduce the read-then-write race inside one accept deterministically:
    // acceptInvite reads existingMembership = null, THEN a concurrent accept
    // commits an active membership for the same user, THEN acceptInvite's own
    // UPDATE runs and the unique index rejects it. We land the competitor in the
    // write window by intercepting the single db.update() acceptInvite makes.
    let injected = false;
    const racingDb = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (...args: unknown[]) => {
            if (!injected) {
              injected = true;
              runStatement(
                sqlite,
                db
                  .update(accountMembers)
                  .set({
                    userId: USER,
                    status: MEMBER_STATUS.ACTIVE,
                    inviteToken: null,
                    inviteExpiresAt: null,
                  })
                  .where(eq(accountMembers.id, "mem_A")),
              );
            }
            return (db.update as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    const result = await acceptInvite(racingDb, "tok_B", USER, EMAIL);

    expect(result).toEqual({ ok: false, reason: "already_member" });
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(active[0].accountId).toBe("acc_A"); // the racer's account, not B
  });
});

describe("MEDIUM #4 sibling: concurrent account creation cannot land two active memberships", () => {
  it("createAccountForUser creates an account + active owner membership for a fresh user (no regression)", async () => {
    const { sqlite, db } = createInMemoryDb();

    const result = await createAccountForUser(withAtomicBatch(sqlite, db), USER, "Fresh Co");

    expect(result.ok).toBe(true);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
  });

  it("a create-account submit that loses the race returns already_member, not a 500, and leaves no orphan account", async () => {
    const { sqlite, db } = createInMemoryDb();

    // The winning concurrent submit already created this user's account + active
    // owner membership. The loser read "no membership" before that committed.
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_W", name: "Winner Co" }));
    runStatement(
      sqlite,
      db.insert(accountMembers).values({
        id: "mem_W",
        accountId: "acc_W",
        userId: USER,
        role: MEMBER_ROLE.OWNER,
        status: MEMBER_STATUS.ACTIVE,
        createdAt: now,
      }),
    );

    const result = await createAccountForUser(withAtomicBatch(sqlite, db), USER, "Loser Co");

    expect(result).toEqual({ ok: false, reason: "already_member" });
    // The rejected owner insert rolled the whole batch back: no "Loser Co" row.
    const accountRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
    expect(accountRows).toEqual([{ id: "acc_W", name: "Winner Co" }]);
    // Still exactly one active membership, in the winner's account.
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(active[0].accountId).toBe("acc_W");
  });
});
