import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Review fixes on PR #63 (second-model review, F1 and F2).
//
// F1: after deletion nobody is signed in to see a failed Stripe revoke, and the
// alert inbox reaches nobody, so each failure must leave a
// durable admin_audit_log row an admin can find and retry from.
//
// F2: the confirmation must say what will actually happen to THIS person: a
// member who owns nothing deletes only themselves, and an owner of several
// accounts deletes every one of them.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const schema = await import("~/db/schema");
const { user } = await import("~/db/auth-schema");
const { deleteUserAccount } = await import("~/lib/auth/delete-account.server");
const { deletionConsequence, ownedAccountNames } = await import("~/lib/auth/deletion-copy");
const { listMemberships } = await import("~/lib/auth/account");

let db: ReturnType<typeof createInMemoryDb>["db"];
const OLD = new Date(Date.UTC(2026, 7, 1));

beforeEach(async () => {
  const made = createInMemoryDb();
  made.sqlite.pragma("foreign_keys = ON");
  db = made.db;
  harness.db = db;
  await db.insert(user).values({ id: "u1", name: "Olive", email: "olive@acme.test", updatedAt: OLD });
  for (const [id, name, role] of [
    ["acct_a", "Acme", "owner"],
    ["acct_b", "Beta Co", "owner"],
    ["acct_c", "Other Co", "member"],
  ] as const) {
    await db.insert(schema.accounts).values({ id, name, createdAt: OLD });
    await db.insert(schema.accountMembers).values({
      id: `m_${id}`,
      accountId: id,
      userId: "u1",
      role,
      status: "active",
      createdAt: OLD,
    });
  }
  await db.insert(schema.stripeConnections).values({
    id: "conn_a",
    accountId: "acct_a",
    stripeUserId: "acct_stripe_a",
    createdAt: OLD,
  });
  await db.insert(schema.stripeConnections).values({
    id: "conn_b",
    accountId: "acct_b",
    stripeUserId: "acct_stripe_b",
    createdAt: OLD,
  });
});

describe("F1: a failed Stripe revoke after deletion is recorded durably", () => {
  it("writes one admin_audit_log row per failed revoke, with no personal data", async () => {
    const result = await deleteUserAccount({} as Env, "u1", {
      deauthorize: async (_env, stripeUserId) =>
        stripeUserId === "acct_stripe_a" ? { ok: false, error: "grant not found" } : { ok: true },
    });
    expect(result.status).toBe("deleted");

    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "user_self_deleted_account_deauthorize_failed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetUserId: "u1",
      targetEmail: null,
      metadata: { connection_id: "conn_a", stripe_user_id: "acct_stripe_a", error: "grant not found" },
    });
    expect(JSON.stringify(rows[0])).not.toContain("olive@acme.test");
  });
});

describe("F2: the confirmation says what will happen to this person", () => {
  it("names the accounts the person owns, and only those, from the session's memberships", async () => {
    // The session's active memberships, which the shell's switcher already
    // shows, carry the same owner and active predicate the deletion plan acts
    // on, so the loader reads no other account's rows.
    expect(ownedAccountNames(await listMemberships(db, "u1"))).toEqual(["Acme", "Beta Co"]);
  });

  it("a member who owns nothing is told only their login and memberships go", () => {
    const copy = deletionConsequence([]);
    expect(copy).toContain("You own no account");
    expect(copy).toContain("no account's data is deleted");
    expect(copy).not.toMatch(/customers/);
    expect(copy).not.toMatch(/recovery sequences/);
  });

  it("an owner of one account is told which account, and what is kept", () => {
    const copy = deletionConsequence(["Acme"]);
    expect(copy).toContain("the account you own, Acme");
    expect(copy).toContain("customers' names and emails");
    expect(copy).toContain("keeps the amounts, dates and Stripe ids of the payments it recovered");
  });

  it("an owner of several accounts is told every one goes, by name", () => {
    const copy = deletionConsequence(["Acme", "Beta Co", null]);
    expect(copy).toContain("all 3 accounts you own (Acme, Beta Co and an unnamed account)");
    expect(copy).toContain("not only the one you are viewing");
  });
});
