import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import { accountMembers, accounts } from "~/db/schema";
import { createAccountForUser, resolveMembership } from "~/lib/auth/account";
import { acceptInvite, createInvite } from "~/lib/auth/invites";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";

import { executeMoneyWrite } from "~/lib/money/execute";
import { SerialMoneyCommitter } from "~/lib/money/serializer";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));

// acceptInvite is a read-then-write, so concurrent accepts can both pass the read; the database
// indexes (real in-memory SQLite, committed migrations) are the guard. Across accounts a user may
// hold many active memberships; within one account a duplicate is refused by
// account_members_user_account_active_uq, and acceptInvite then reports alreadyMember.

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
    .where(and(eq(accountMembers.userId, USER), eq(accountMembers.status, MEMBER_STATUS.ACTIVE)));
}

// createAccountForUser commits through the money-write Durable Object; this fake gives the batch
// all-or-nothing semantics and the idempotency that makes a re-delivered key a no-op.
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

describe("concurrent invite acceptance cannot land two active memberships", () => {
  it("a single accept activates the invite and clears the token", async () => {
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

  it("two concurrent accepts for the SAME account are still rejected by the DB", async () => {
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

  it("a SECOND accept of the same account reports success and writes nothing", async () => {
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

    // A competitor commits an active membership on acc_A inside acceptInvite's read-then-write window.
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

  it("an invite whose token changed between the read and the write is refused and activates nothing", async () => {
    const { sqlite, db } = seedTwoInvites();
    // The owner resends (a new token) after acceptInvite has read the old one.
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
                  .set({ inviteToken: "tok_A_new" })
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

    const result = await acceptInvite(racingDb, "tok_A", USER, EMAIL);

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(await activeMemberships(db)).toHaveLength(0);
  });
});

describe("concurrent account creation cannot land two active memberships", () => {
  // Both submits share one idempotency key, so the second is a re-delivery and the loser reports the winner's account.
  it("two concurrent first-connect submits yield ONE account and ONE membership", async () => {
    const { sqlite, db } = createInMemoryDb();
    installDo(sqlite, db);

    const [winner, loser] = await Promise.all([
      createAccountForUser(ENV, db, USER, "First Co"),
      createAccountForUser(ENV, db, USER, "Second Co"),
    ]);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(true);
    expect(winner.ok && loser.ok && winner.accountId).toBe(loser.ok && loser.accountId);

    const accountRows = await db.select({ name: accounts.name }).from(accounts);
    expect(accountRows).toHaveLength(1);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
  });

  it("a submit that loses to an already-committed winner reports the winner's account", async () => {
    const { sqlite, db } = createInMemoryDb();
    installDo(sqlite, db);

    // The winning submit already committed under the key a first connect uses.
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

    const accountRows = await db.select({ name: accounts.name }).from(accounts);
    expect(accountRows.map((r) => r.name)).toEqual(["Winner Co"]);
    const active = await activeMemberships(db);
    expect(active).toHaveLength(1);
    expect(result).toEqual({ ok: true, accountId: "acc_W" });
    expect(await resolveMembership(db, USER)).toMatchObject({ accountId: "acc_W" });
  });

  // A DO that dies between D1 commit and marking the key seen forgets it; the retry must still find the first account.
  it("a retry after the DO lost its seen key reports the first account and creates no second", async () => {
    const { sqlite, db } = createInMemoryDb();
    // A fresh committer per call: the real serializer, with nothing remembered.
    vi.mocked(executeMoneyWrite).mockImplementation(async (_env, write) => {
      const committer = new SerialMoneyCommitter({
        hasSeen: async () => false,
        markSeen: async () => {},
        runBatch: async (statements) => {
          sqlite.transaction(() => {
            for (const s of statements) sqlite.prepare(s.sql).run(...(s.params as never[]));
          })();
        },
      });
      const statements = write
        .build(db)
        .map((item) =>
          (item as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL(),
        );
      return committer.commit({ idempotencyKey: write.idempotencyKey, statements });
    });

    const first = await createAccountForUser(ENV, db, USER, "First Co");
    const retry = await createAccountForUser(ENV, db, USER, "First Co");

    expect(first.ok && retry.ok && retry.accountId).toBe(first.ok && first.accountId);
    expect(await db.select({ id: accounts.id }).from(accounts)).toHaveLength(1);
  });
});

describe("an invite stores only its token's hash", () => {
  it("the row holds no raw token, and the link's token still accepts", async () => {
    const { sqlite, db } = createInMemoryDb();
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_A", name: "Acme A" }));

    const { token } = await createInvite(db, "acc_A", EMAIL);

    const stored = await db.select({ token: accountMembers.inviteToken }).from(accountMembers);
    expect(stored[0].token).not.toBe(token);
    expect(await acceptInvite(db, token, USER, EMAIL)).toEqual({
      ok: true,
      accountId: "acc_A",
      alreadyMember: false,
    });
  });
});
