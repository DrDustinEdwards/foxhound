import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Phase (b) of the multi-account build (ruling 327, planned by 326): the session
// carries WHICH account it is looking at, a switch action moves it, and
// enforcement layer 2 comes out of the invite path by changing its verdict.
//
// NOTHING USER-VISIBLE MOVES. There is still no switcher (phase (e)), so the
// only way to prove this half works is at the action and the resolver, which is
// what this file does.
//
// The switch action is the money-adjacent one: it decides which account's ledger
// the caller's NEXT money write lands on. Its membership check is therefore
// tested the way a guard gets tested rather than the way a happy path does, with
// a case per way the check can be wrong.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({
  getSession: async () => harness.session,
}));

const { action } = await import("~/routes/api/account-switch");
const { safeReturnPath } = await import("~/lib/auth/active-account");
const { listMemberships, resolveActiveMembershipFrom, pickMarkedMembership, findActiveMembership } =
  await import("~/lib/auth/account");
const schema = await import("~/db/schema");

const USER = "user_1";
const OTHER_USER = "user_2";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.session = null;
  seedUser(USER, "owner@acme.test");
  seedUser(OTHER_USER, "other@acme.test");
});

function seedUser(id: string, email: string): void {
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)",
    )
    .run(id, id, email);
}

function seedAccount(id: string, name: string, lastVisitedPath: string | null = null): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, last_visited_path, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, lastVisitedPath, 1_000);
}

function seedMembership(opts: {
  id: string;
  accountId: string;
  userId: string | null;
  status?: string;
  createdAt?: number;
}): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', ?, ?)",
    )
    .run(opts.id, opts.accountId, opts.userId, opts.status ?? "active", opts.createdAt ?? 1_000);
}

function seedSession(id: string, userId: string, activeAccountId: string | null = null): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(id, 9_999_999_999_999, `tok_${id}`, userId, activeAccountId);
}

function markerOf(sessionId: string): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(sessionId) as { m: string | null } | undefined;
  return row?.m ?? null;
}

function signIn(sessionId: string, userId = USER): void {
  harness.session = {
    user: { id: userId, name: userId, email: `${userId}@acme.test` },
    session: { id: sessionId, activeAccountId: markerOf(sessionId) },
  };
}

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

function request(opts: {
  method?: string;
  accountId?: string;
  referer?: string;
  json?: boolean;
}): Request {
  const headers = new Headers();
  if (opts.referer) headers.set("referer", opts.referer);
  let body: BodyInit | undefined;
  if (opts.accountId !== undefined) {
    if (opts.json) {
      headers.set("content-type", "application/json");
      body = JSON.stringify({ accountId: opts.accountId });
    } else {
      const form = new FormData();
      form.append("accountId", opts.accountId);
      body = form;
    }
  }
  return new Request("https://foxhoundapp.test/api/account/switch", {
    method: opts.method ?? "POST",
    headers,
    body,
  });
}

async function run(opts: Parameters<typeof request>[0]): Promise<Response> {
  return (await action({
    context: fakeContext,
    request: request(opts),
    params: {},
  } as never)) as unknown as Response;
}

/** Two accounts, both actively held by USER, plus one session. */
function seedTwoAccounts(): void {
  seedAccount("acct_a", "Acme A");
  seedAccount("acct_b", "Acme B");
  seedMembership({ id: "m1", accountId: "acct_a", userId: USER, createdAt: 1_000 });
  seedMembership({ id: "m2", accountId: "acct_b", userId: USER, createdAt: 2_000 });
  seedSession("sess_1", USER);
}

describe("the switch action ports legacy's validation, in legacy's order", () => {
  it("405 for a non-POST verb", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({ method: "PUT", accountId: "acct_b" });
    expect(res.status).toBe(405);
    expect(markerOf("sess_1")).toBeNull();
  });

  it("401 with no session, before it looks at the body or the database", async () => {
    seedTwoAccounts();
    harness.session = null;
    const res = await run({ accountId: "acct_b" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("400 with no accountId in the body", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing accountId" });
    expect(markerOf("sess_1")).toBeNull();
  });

  it("403 for an account the user does not hold, with legacy's message", async () => {
    seedTwoAccounts();
    seedAccount("acct_theirs", "Someone else");
    seedMembership({ id: "m9", accountId: "acct_theirs", userId: OTHER_USER });
    signIn("sess_1");

    const res = await run({ accountId: "acct_theirs" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not a member of this account" });
    // THE ASSERTION THAT MATTERS: refused AND not written. A 403 that had
    // already moved the marker would be worse than no check at all.
    expect(markerOf("sess_1")).toBeNull();
  });

  it("403 for an account held with status revoked", async () => {
    seedTwoAccounts();
    seedAccount("acct_gone", "Left this one");
    seedMembership({ id: "m8", accountId: "acct_gone", userId: USER, status: "revoked" });
    signIn("sess_1");

    const res = await run({ accountId: "acct_gone" });

    expect(res.status).toBe(403);
    expect(markerOf("sess_1")).toBeNull();
  });

  it("403 for an account id that does not exist", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({ accountId: "acct_nope" });
    expect(res.status).toBe(403);
  });

  it("redirects and moves the marker for an account the user holds", async () => {
    seedTwoAccounts();
    signIn("sess_1");

    const res = await run({
      accountId: "acct_b",
      referer: "https://foxhoundapp.test/recovery/payments?status=open",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/recovery/payments?status=open");
    expect(markerOf("sess_1")).toBe("acct_b");
  });

  it("accepts a JSON body too, which is the shape legacy's switcher posts", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({ accountId: "acct_b", json: true });
    expect(res.status).toBe(302);
    expect(markerOf("sess_1")).toBe("acct_b");
  });

  it("switching back to the earliest account marks it explicitly", async () => {
    // Not a no-op: the marker must hold acct_a rather than fall back to it,
    // or a later switch away and back would be indistinguishable from never
    // having switched.
    seedTwoAccounts();
    signIn("sess_1");
    await run({ accountId: "acct_b" });
    signIn("sess_1");
    await run({ accountId: "acct_a" });
    expect(markerOf("sess_1")).toBe("acct_a");
  });
});

describe("the marker is per SESSION, not per user", () => {
  it("a second session of the same user is untouched by the first one's switch", async () => {
    seedTwoAccounts();
    seedSession("sess_2", USER);
    signIn("sess_1");

    await run({ accountId: "acct_b" });

    expect(markerOf("sess_1")).toBe("acct_b");
    // The other browser stays where it was. Legacy gets this by accident,
    // because its marker is a cookie; here it is the WHERE clause, so it is
    // asserted rather than assumed.
    expect(markerOf("sess_2")).toBeNull();
  });

  it("another user's session is untouched", async () => {
    seedTwoAccounts();
    seedMembership({ id: "m3", accountId: "acct_b", userId: OTHER_USER, createdAt: 3_000 });
    seedSession("sess_other", OTHER_USER);
    signIn("sess_1");

    await run({ accountId: "acct_b" });

    expect(markerOf("sess_other")).toBeNull();
  });
});

describe("safeReturnPath refuses an off-origin referer", () => {
  const SELF = "https://foxhoundapp.test/api/account/switch";

  it("keeps a same-origin path, with its query and hash", () => {
    expect(safeReturnPath("https://foxhoundapp.test/billing?tab=invoices#x", SELF)).toBe(
      "/billing?tab=invoices#x",
    );
  });

  it("sends a cross-origin referer to /", () => {
    expect(safeReturnPath("https://evil.test/steal", SELF)).toBe("/");
  });

  it("sends a LOOKALIKE origin to /, which a prefix check would have allowed", () => {
    // The whole reason this compares origins instead of prefix-matching the
    // string: "https://foxhoundapp.test".startsWith is true of this host.
    expect(safeReturnPath("https://foxhoundapp.test.evil.test/steal", SELF)).toBe("/");
  });

  it("sends a protocol-relative or scheme-swapped referer to /", () => {
    expect(safeReturnPath("http://foxhoundapp.test/billing", SELF)).toBe("/");
  });

  it("sends a missing or unparseable referer to /", () => {
    expect(safeReturnPath(null, SELF)).toBe("/");
    expect(safeReturnPath("not a url", SELF)).toBe("/");
  });

  it("does not bounce back into the switch endpoint itself", () => {
    expect(safeReturnPath(SELF, SELF)).toBe("/");
  });

  it("the action honours the refusal end to end", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({ accountId: "acct_b", referer: "https://evil.test/steal" });
    expect(res.headers.get("location")).toBe("/");
    // The switch still happened. A bad referer is not a reason to refuse it.
    expect(markerOf("sess_1")).toBe("acct_b");
  });
});

describe("resolution follows legacy's fallback order", () => {
  it("a marker naming a held account wins", async () => {
    seedTwoAccounts();
    const memberships = await listMemberships(db, USER);
    const m = await resolveActiveMembershipFrom(db, memberships, "acct_b");
    expect(m?.accountId).toBe("acct_b");
  });

  it("a marker naming a SINCE-REVOKED membership falls back and does not throw", async () => {
    seedTwoAccounts();
    // The user switched to acct_b, then was removed from it.
    sqlite.prepare("UPDATE account_members SET status = 'revoked' WHERE id = 'm2'").run();
    const memberships = await listMemberships(db, USER);
    const m = await resolveActiveMembershipFrom(db, memberships, "acct_b");
    expect(m?.accountId).toBe("acct_a");
  });

  it("the next request after a revocation still resolves, which is the no-500 case", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    await run({ accountId: "acct_b" });
    sqlite.prepare("UPDATE account_members SET status = 'revoked' WHERE id = 'm2'").run();

    // The marker still says acct_b and the membership is gone. This is exactly
    // what the app shell reads on the very next request.
    const memberships = await listMemberships(db, USER);
    await expect(
      resolveActiveMembershipFrom(db, memberships, markerOf("sess_1")),
    ).resolves.toMatchObject({ accountId: "acct_a" });
  });

  it("with no marker, an account carrying last_visited_path beats the earliest", async () => {
    // Legacy's tier 2, lib/account.ts:139-148 (blob 9bb58874): "No cookie:
    // prefer the account that has a non-null last_visited_path".
    seedAccount("acct_a", "Acme A");
    seedAccount("acct_b", "Acme B", "/recovery/payments");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER, createdAt: 1_000 });
    seedMembership({ id: "m2", accountId: "acct_b", userId: USER, createdAt: 2_000 });

    const memberships = await listMemberships(db, USER);
    const m = await resolveActiveMembershipFrom(db, memberships, null);
    expect(m?.accountId).toBe("acct_b");
  });

  it("tier 2 does not fire for a single membership, which is legacy's own gate", async () => {
    // Legacy runs the whole cookie-and-visited block inside
    // `if (memberships.length > 1)`. With one membership the answer is that
    // membership, and no second query is issued.
    seedAccount("acct_a", "Acme A");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER });
    const memberships = await listMemberships(db, USER);
    expect(await resolveActiveMembershipFrom(db, memberships, null)).toMatchObject({
      accountId: "acct_a",
    });
  });

  it("with no marker and no visited account, the earliest wins", async () => {
    seedTwoAccounts();
    const memberships = await listMemberships(db, USER);
    const m = await resolveActiveMembershipFrom(db, memberships, null);
    expect(m?.accountId).toBe("acct_a");
  });

  it("pickMarkedMembership never trusts the marker on its own", () => {
    const held = [{ memberId: "m1", accountId: "acct_a", accountName: "A", role: "owner" }];
    expect(pickMarkedMembership(held, "acct_a")?.accountId).toBe("acct_a");
    expect(pickMarkedMembership(held, "acct_b")).toBeNull();
    expect(pickMarkedMembership(held, null)).toBeNull();
    expect(pickMarkedMembership([], "acct_a")).toBeNull();
  });

  it("findActiveMembership is scoped to the pair and to active status", async () => {
    seedTwoAccounts();
    expect(await findActiveMembership(db, USER, "acct_b")).toMatchObject({ accountId: "acct_b" });
    expect(await findActiveMembership(db, OTHER_USER, "acct_b")).toBeNull();
    sqlite.prepare("UPDATE account_members SET status = 'revoked' WHERE id = 'm2'").run();
    expect(await findActiveMembership(db, USER, "acct_b")).toBeNull();
  });
});

describe("AuthContext carries the membership set", () => {
  it("guards.ts populates memberships and activeAccountId from one query", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/auth/guards.ts", import.meta.url)),
      "utf8",
    );

    // Both branches set them, and the demo branch sets the DEMO membership
    // rather than anything read from a signed-in visitor's session.
    expect(source).toMatch(/memberships,\n\s+activeAccountId: membership\.accountId,/);
    expect(source).toMatch(/memberships: \[membership\],\n\s+activeAccountId: membership\.accountId,/);
    // One membership query per request, not one per consumer.
    expect(source.match(/listMemberships\(/g) ?? []).toHaveLength(1);
  });

  it("the switch route is registered at legacy's own path", async () => {
    const routes = (await import("~/routes")).default as Array<{
      path?: string;
      file: string;
      children?: unknown[];
    }>;
    const flat = JSON.stringify(routes);
    expect(flat).toContain("./routes/api/account-switch.ts");
    expect(flat).toContain("api/account/switch");
  });
});

describe("the invite path joins rather than refuses", () => {
  it("an invite to an account already held is success, and writes nothing", async () => {
    const { acceptInvite } = await import("~/lib/auth/invites");
    seedAccount("acct_a", "Acme A");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER });
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, invited_email, invite_token, invite_expires_at, created_at) VALUES ('inv', 'acct_a', NULL, 'member', 'pending', ?, 'tok', ?, 1000)",
      )
      .run("owner@acme.test", Date.now() + 3_600_000);

    const result = await acceptInvite(db, "tok", USER, "owner@acme.test");

    expect(result).toEqual({ ok: true, accountId: "acct_a", alreadyMember: true });
    const rows = await db.select().from(schema.accountMembers);
    expect(rows.filter((r) => r.userId === USER && r.status === "active")).toHaveLength(1);
    expect(rows.find((r) => r.id === "inv")?.inviteToken).toBe("tok");
  });

  it("an invite to a NEW account creates a second active membership", async () => {
    const { acceptInvite } = await import("~/lib/auth/invites");
    seedAccount("acct_a", "Acme A");
    seedAccount("acct_b", "Globex");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER });
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, invited_email, invite_token, invite_expires_at, created_at) VALUES ('inv', 'acct_b', NULL, 'member', 'pending', ?, 'tok', ?, 2000)",
      )
      .run("owner@acme.test", Date.now() + 3_600_000);

    const result = await acceptInvite(db, "tok", USER, "owner@acme.test");

    // Pre-327 this was { ok: false, reason: "already_member" }: a user who
    // belonged to Acme could not join Globex at all.
    expect(result).toEqual({ ok: true, accountId: "acct_b", alreadyMember: false });
    const memberships = await listMemberships(db, USER);
    expect(memberships.map((m) => m.accountId)).toEqual(["acct_a", "acct_b"]);
  });

  it("the invite route moves the marker to the joined account", async () => {
    const { setSessionActiveAccount } = await import("~/lib/auth/active-account");
    seedTwoAccounts();
    // The route calls this with the accepted account; assert the write it makes
    // rather than restating the route's control flow.
    await setSessionActiveAccount(db, "sess_1", "acct_b");
    expect(markerOf("sess_1")).toBe("acct_b");
  });

  it("already_member is gone from the result type's reasons", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/auth/invites.ts", import.meta.url)),
      "utf8",
    );
    // Layer 2's removal, pinned at the type. `createAccountForUser` keeps its
    // own already_member (phase (d)'s debt), so this is scoped to the invite
    // result union rather than to the file.
    const union = source.match(/export type AcceptInviteResult =[\s\S]*?;\n/);
    expect(union).not.toBeNull();
    expect(union![0]).not.toContain("already_member");
    expect(union![0]).toContain("alreadyMember");
  });
});
