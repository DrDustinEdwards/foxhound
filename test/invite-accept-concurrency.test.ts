import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accountMembers, accounts } from "~/db/schema";
import { acceptInvite, createAccountForUser, resolveMembership } from "~/lib/auth/account";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";

import { executeMoneyWrite } from "~/lib/money/execute";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));

// Cross-tenant regression for account-scoping audit MEDIUM #4: acceptInvite is a
// read-then-write (check the user's memberships, then activate the invite row),
// so two concurrent accepts can both pass the read before either commits and the
// read alone cannot enforce anything. A database index is the structural guard.
// Proven against a REAL in-memory SQLite with the committed migrations applied,
// so the index (not a SQL-shape assertion) is what stops the second membership.
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
//
// PHASE (b), RULING 327, CHANGES WHAT THE COLLISION REPORTS. The database still
// refuses a duplicate active pair, but `acceptInvite` no longer surfaces that as
// a failure: the loser's UPDATE failed precisely because the winner already made
// this user a member of this account, so the caller's question is answered yes
// and the result is `{ ok: true, alreadyMember: true }` with nothing written.
// `already_member` is gone as a rejection reason entirely.

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

// createAccountForUser now commits through the money-write Durable Object
// (ruling 329 phase (d)), which the better-sqlite3 harness has no binding for.
// This models the DO faithfully in the two ways the assertions depend on:
// sqlite.transaction gives the batch D1's all-or-nothing semantics, and the seen
// set gives it the idempotency that makes a re-delivered key a no-op. Without
// the second half the double-submit test would prove nothing, because the fix
// IS the idempotency.
const seen = new Set<string>();
const ENV = {} as Env;

function installDo(sqlite: Parameters<typeof runStatement>[0], db: Db): void {
  seen.clear();
  vi.mocked(executeMoneyWrite).mockImplementation(async (_env, write) => {
    if (seen.has(write.idempotencyKey)) return { applied: false };
    seen.add(write.idempotencyKey);
    const statements = write.build(db);
    sqlite.transaction(() => {
      for (const stmt of statements) runStatement(sqlite, stmt);
    })();
    return { applied: true };
  });
}

describe("MEDIUM #4: concurrent invite acceptance cannot land two active memberships", () => {
  it("a single accept activates the invite and clears the token (no regression)", async () => {
    const { db } = seedTwoInvites();

    const result = await acceptInvite(db, "tok_A", USER, EMAIL);

    expect(result).toEqual({ ok: true, accountId: "acc_A", alreadyMember: false });
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

  it("a SECOND accept of the same account reports success and writes nothing (327)", async () => {
    // The same collision seen through acceptInvite rather than through raw SQL.
    // Pre-327 this was `{ ok: false, reason: "already_member" }`, so a merchant
    // double-clicking Accept saw a failure over a membership that existed.
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

    await acceptInvite(db, "tok_A", USER, EMAIL);
    const second = await acceptInvite(db, "tok_A2", USER, EMAIL);

    expect(second).toEqual({ ok: true, accountId: "acc_A", alreadyMember: true });
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    // Nothing written: the second invite row is untouched, token intact.
    const row = await db
      .select({ token: accountMembers.inviteToken, status: accountMembers.status })
      .from(accountMembers)
      .where(eq(accountMembers.id, "mem_A2"));
    expect(row[0].token).toBe("tok_A2");
    expect(row[0].status).toBe(MEMBER_STATUS.PENDING);
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

    expect(result).toEqual({ ok: true, accountId: "acc_B", alreadyMember: false });
    const active = await activeMemberships(db);
    expect(active).toHaveLength(2);
    expect(active.map((m) => m.accountId).sort()).toEqual(["acc_A", "acc_B"]);
  });
});

describe("MEDIUM #4 sibling: concurrent account creation cannot land two active memberships", () => {
  it("createAccountForUser creates an account + active owner membership for a fresh user (no regression)", async () => {
    const { sqlite, db } = createInMemoryDb();
    installDo(sqlite, db);

    const result = await createAccountForUser(ENV, db, USER, "Fresh Co");

    expect(result.ok).toBe(true);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
  });

  // THE DEBT 327 NAMED AND PHASE (a) LEFT RED ON PURPOSE, NOW PAID.
  //
  // This case asserted the DEFECT for two sessions: the struck index was unique
  // on user_id, its replacement is unique on (user_id, account_id), and two
  // racing submits mint two different account ids, so neither violated it and
  // both committed. One double-click, two accounts. Phase (a) rewrote the
  // assertion to the broken behaviour deliberately, so phase (d) would have to
  // come back and change it on purpose rather than inherit a green.
  //
  // The fix is 327's, verbatim: "an idempotency key on the connect submit, not a
  // per-user constraint". Both submits go through ONE money-write Durable Object
  // partitioned by the user with the SAME key, so the second is a re-delivery
  // and no-ops, and the loser reports the winner's account.
  it("two concurrent first-connect submits yield ONE account and ONE membership", async () => {
    const { sqlite, db } = createInMemoryDb();
    installDo(sqlite, db);

    const [winner, loser] = await Promise.all([
      createAccountForUser(ENV, db, USER, "First Co"),
      createAccountForUser(ENV, db, USER, "Second Co"),
    ]);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(true);
    // BOTH report the same account, which is the part that matters to the
    // caller: /connect redirects and the loader must find the account they were
    // told about.
    expect(winner.ok && loser.ok && winner.accountId).toBe(loser.ok && loser.accountId);

    const accountRows = await db.select({ name: accounts.name }).from(accounts);
    expect(accountRows).toHaveLength(1);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
  });

  it("a submit that loses to an already-committed winner reports the winner's account", async () => {
    const { sqlite, db } = createInMemoryDb();
    installDo(sqlite, db);

    // The winning submit already committed, under the key this user's first
    // connect always uses.
    seen.add(`connect:first:${USER}`);
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

    const result = await createAccountForUser(ENV, db, USER, "Loser Co");

    // No "Loser Co" row anywhere: the DO recognised the re-delivery and wrote
    // nothing, so there is no orphan to be invisible.
    const accountRows = await db.select({ name: accounts.name }).from(accounts);
    expect(accountRows.map((r) => r.name)).toEqual(["Winner Co"]);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(result).toEqual({ ok: true, accountId: "acc_W" });
    expect(await resolveMembership(db, USER)).toMatchObject({ accountId: "acc_W" });
  });
});
