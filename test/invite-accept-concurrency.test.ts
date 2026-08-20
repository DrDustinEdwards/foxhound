import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accountMembers, accounts } from "~/db/schema";
import { acceptInvite, createAccountForUser, resolveMembership } from "~/lib/auth/account";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Cross-tenant regression for account-scoping audit MEDIUM #4: acceptInvite is a
// read-then-write (check the user's memberships, then activate the invite row),
// so two concurrent accepts can both pass the read before either commits and the
// read alone cannot enforce anything. A database index is the structural guard,
// and acceptInvite maps the rejected write back to already_member. Proven against
// a REAL in-memory SQLite with the committed migrations applied, so the index
// (not a SQL-shape assertion) is what stops the second membership.
//
// REAIMED AT PHASE (a) OF THE MULTI-ACCOUNT BUILD (rulings 324 and 326). The
// guard used to be `account_members_one_active_per_user_uq`, unique on `user_id`
// alone, and this file asserted that a user could never hold two active
// memberships. That is the constraint 324 STRUCK: many accounts per user is the
// product, and legacy has always worked that way. The property worth protecting
// survives in a narrower form and is what the rewritten cases below assert:
//
//   ACROSS two accounts, a double accept is now LEGAL and both land.
//   WITHIN one account, a double accept is still refused, by the replacement
//   index `account_members_user_account_active_uq` on (user_id, account_id).
//
// Legacy agrees on both halves: app/api/invite/accept/route.ts:47-57 (blob
// 13708537) scopes its own duplicate check to `(account_id, user_id)`, not to
// the user. The tests are therefore not weakened, they are re-aimed at the pair
// that was always the real invariant.

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

  it("two concurrent accepts for DIFFERENT accounts both land, and that is the point of 324", async () => {
    const { sqlite, db } = seedTwoInvites();

    // Racer A wins and commits its activation.
    const a = await acceptInvite(db, "tok_A", USER, EMAIL);
    expect(a.ok).toBe(true);

    // Racer B already passed its existing-membership read (null, captured before
    // A committed), so it proceeds straight to activation. Its UPDATE is the
    // exact statement acceptInvite issues. Under the struck index this threw;
    // under the replacement it is a legitimate second membership on a second
    // account, which is precisely the behaviour the product now wants.
    const bWrite = db
      .update(accountMembers)
      .set({
        userId: USER,
        status: MEMBER_STATUS.ACTIVE,
        inviteToken: null,
        inviteExpiresAt: null,
      })
      .where(eq(accountMembers.id, "mem_B"));
    expect(() => runStatement(sqlite, bWrite)).not.toThrow();

    const active = await activeMemberships(db);
    expect(active).toHaveLength(2);
    expect(active.map((m) => m.accountId).sort()).toEqual(["acc_A", "acc_B"]);
  });

  it("two concurrent accepts for the SAME account are still rejected by the DB", async () => {
    // The half of the old assertion that survives 324, and the one that was
    // always the real defect: one user, two active rows, one account. A second
    // pending invite to acc_A, racing the first.
    const { sqlite, db } = seedTwoInvites();
    runStatement(
      sqlite,
      db.insert(accountMembers).values({
        id: "mem_A2",
        accountId: "acc_A",
        userId: null,
        role: MEMBER_ROLE.MEMBER,
        invitedEmail: EMAIL,
        status: MEMBER_STATUS.PENDING,
        inviteToken: "tok_A2",
        inviteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: now,
      }),
    );

    const a = await acceptInvite(db, "tok_A", USER, EMAIL);
    expect(a.ok).toBe(true);

    const duplicate = db
      .update(accountMembers)
      .set({
        userId: USER,
        status: MEMBER_STATUS.ACTIVE,
        inviteToken: null,
        inviteExpiresAt: null,
      })
      .where(eq(accountMembers.id, "mem_A2"));
    expect(() => runStatement(sqlite, duplicate)).toThrow(/unique constraint/i);

    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(active[0].accountId).toBe("acc_A");
  });

  it("acceptInvite whose competitor took a DIFFERENT account now succeeds, and the user holds both", async () => {
    const { sqlite, db } = seedTwoInvites();

    // Reproduce the read-then-write race inside one accept deterministically:
    // acceptInvite reads existingMembership = null, THEN a concurrent accept
    // commits an active membership for the same user on acc_A, THEN
    // acceptInvite's own UPDATE for acc_B runs. We land the competitor in the
    // write window by intercepting the single db.update() acceptInvite makes.
    //
    // The struck index turned that into an already_member refusal. It is now a
    // success: the two activations are for two different accounts, which is the
    // legal case. `evaluateAcceptInvite`'s own already_member refusal (layer 2,
    // ruling 326) does NOT fire here, because it runs on the read and the read
    // happened before the competitor committed. That refusal is removed in phase
    // (b); this case documents that the DATABASE already permits what layer 2
    // still blocks on the non-racing path.
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

    expect(result).toEqual({ ok: true, accountId: "acc_B" });
    const active = await activeMemberships(db);
    expect(active).toHaveLength(2);
    expect(active.map((m) => m.accountId).sort()).toEqual(["acc_A", "acc_B"]);
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

  // KNOWN DEFECT, RECORDED RATHER THAN ASSERTED AWAY, owed to phase (d).
  //
  // The create-account double-submit race is NO LONGER CAUGHT. The struck index
  // was unique on user_id, so the loser's owner-membership insert violated it and
  // the whole batch rolled back. The replacement is unique on
  // (user_id, account_id), and the two racing submits mint two DIFFERENT account
  // ids, so neither violates it and both commit: one double-click, two accounts.
  //
  // It is invisible at HEAD, which is why phase (a) ships with it: resolveMembership
  // returns the earliest membership, so the loser's account is never resolved and
  // no surface can reach it. It is still an orphan row per double submit.
  //
  // The fix belongs to phase (d), which owns connect.tsx (this function's only
  // caller) and builds the add-account flow. Once an intentional second account
  // has its own marked path, an UNMARKED create is a duplicate submit by
  // definition and can be refused on that basis. Phase (a) is forbidden from
  // touching connect.tsx (ruling 326), so this is named, not fixed.
  //
  // This case asserts what the code ACTUALLY does now. It is deliberately not
  // written to pass under both behaviours, so phase (d) has to come back and
  // change it on purpose.
  it("a create-account submit that loses the race NOW SUCCEEDS and leaves a second account (phase (d) fixes this)", async () => {
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

    expect(result.ok).toBe(true);
    // Both accounts exist. "Loser Co" is the orphan the defect note above names.
    const accountRows = await db.select({ name: accounts.name }).from(accounts);
    expect(accountRows.map((r) => r.name).sort()).toEqual(["Loser Co", "Winner Co"]);
    // Two active memberships for one user, which the database now permits.
    const active = await activeMemberships(db);
    expect(active).toHaveLength(2);
    // And the invisibility half: every existing caller resolves the EARLIEST
    // membership, so the orphan is unreachable from any surface at phase (a).
    expect(await resolveMembership(db, USER)).toMatchObject({ accountId: "acc_W" });
  });
});
