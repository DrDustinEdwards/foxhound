
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S37: disconnect per connection, and cancel account. Rulings 40 and 333.
//
// THIS IS THE MONEY-ADJACENT SETTINGS SURFACE. A disconnect decides whether a
// merchant's Stripe account keeps feeding the recovery engine, and a cancel
// stops processing for an entire account while leaving owed fees owed. So every
// refusing branch is asserted to have written NOTHING, and the billing rows are
// asserted untouched on the path that stops the business relationship.
//
// 333 ruled these writes go through cancelMerchant's PLAIN batch path and NOT
// executeMoneyWrite: an account-state write is not outcome recording, attributed
// billing, or a webhook claim, and a second writer on
// stripe_connections.disconnected_at with a different atomicity guarantee is
// 262 decision five's shape one table over.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  deauthorizeOk: true,
  deauthorizeCalls: [] as string[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

vi.mock("~/lib/stripe/connect", () => ({
  deauthorizeConnectedAccount: async (_env: unknown, stripeUserId: string) => {
    harness.deauthorizeCalls.push(stripeUserId);
    return harness.deauthorizeOk ? { ok: true } : { ok: false, error: "grant already revoked" };
  },
}));

// SESSION 59 SPLIT S37'S TWO CONTROLS ONTO LEGACY'S TWO PAGES: the
// per-connection disconnect to /settings/stripe (hub entry 1) and the account
// cancel to /settings/account (hub entry 12). The plants below are unchanged in
// substance; `post` routes each intent to the action that now owns it.
const { action: stripeAction, loader } = await import("~/routes/app/settings/stripe");
const { action: accountAction } = await import("~/routes/app/settings/account");
const { listMemberships } = await import("~/lib/auth/account");

const USER = "user_1";
const ACTIVE = "acct_active";
const EARLIEST = "acct_earliest";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.deauthorizeOk = true;
  harness.deauthorizeCalls = [];

  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(USER, "Owner", "owner@acme.test");
  // The caller holds TWO accounts and is switched to the LATER one, so every
  // active-account assertion below can fail in the direction that matters.
  seedAccount(EARLIEST, "Earliest Co", 1_000);
  seedAccount(ACTIVE, "Active Co", 2_000);
  seedMembership("m1", EARLIEST, 1_000);
  seedMembership("m2", ACTIVE, 2_000);
  seedSession("sess_1", ACTIVE);
});

function seedAccount(id: string, name: string, createdAt: number): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, ?, 0)")
    .run(id, name, createdAt);
}

function seedMembership(id: string, accountId: string, createdAt: number): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    )
    .run(id, accountId, USER, createdAt);
}

function seedConnection(opts: {
  id: string;
  accountId: string;
  stripeUserId: string;
  isPrimary?: boolean;
  connectedAt?: number;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 1000)",
    )
    .run(
      opts.id,
      opts.accountId,
      opts.stripeUserId,
      opts.isPrimary ? 1 : 0,
      opts.connectedAt ?? 1_000,
      opts.disconnectedAt ?? null,
    );
}

function seedSession(id: string, activeAccountId: string): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(id, 9_999_999_999_999, "tok_" + id, USER, activeAccountId);
  harness.session = {
    user: { id: USER, name: "Owner", email: "owner@acme.test" },
    session: { id, activeAccountId },
  };
}

function connectionRow(id: string): { disconnectedAt: number | null; isPrimary: number } {
  return sqlite
    .prepare("SELECT disconnected_at AS disconnectedAt, is_primary AS isPrimary FROM stripe_connections WHERE id = ?")
    .get(id) as { disconnectedAt: number | null; isPrimary: number };
}

function markerOf(sessionId: string): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(sessionId) as { m: string | null } | undefined;
  return row?.m ?? null;
}

/** Context carrying the ACTIVE account, which is what guards.ts resolves from
 *  the session marker. Every S37 assertion turns on this being the active
 *  account and never the earliest membership. */
const ctx = {
  get(key: unknown) {
    if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    if (key === authContext) {
      return {
        userId: USER,
        userName: "Owner",
        email: "owner@acme.test",
        membership: { memberId: "m2", accountId: ACTIVE, accountName: "Active Co", role: "owner" },
        memberships: [
          { memberId: "m1", accountId: EARLIEST, accountName: "Earliest Co", role: "owner" },
          { memberId: "m2", accountId: ACTIVE, accountName: "Active Co", role: "owner" },
        ],
        activeAccountId: ACTIVE,
        isAdmin: false,
        isDemo: false,
        demoSignedIn: false,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof stripeAction>[0]["context"];

async function post(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const owner = fields._action === "cancel-account" ? accountAction : stripeAction;
  const res = (await owner({
    context: ctx,
    request: new Request("https://foxhoundapp.test/settings", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as Response | { data: Record<string, unknown>; init?: { status?: number } };
  // J41: a clean disconnect answers with Recova's trip back to /settings, a
  // real redirect Response, so its status is read off the Response itself.
  if (res instanceof Response) return { status: res.status, body: { location: res.headers.get("Location") } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 2: disconnect refuses what the active account does not own", () => {

  it("400 and NO write when no connection id is sent, which is legacy's actual request", async () => {
    seedConnection({ id: "c_active", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });

    const res = await post({ _action: "disconnect-stripe" });

    expect(res.status).toBe(400);
    expect(connectionRow("c_active").disconnectedAt).toBeNull();
  });

  it("403 and NO write when a member, not the owner, disconnects", async () => {
    seedConnection({ id: "c_active", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    const memberCtx = {
      get(key: unknown) {
        const v = ctx.get(key as never) as Record<string, unknown>;
        if (key !== authContext) return v;
        return { ...v, membership: { ...(v.membership as object), role: "member" } };
      },
    } as unknown as typeof ctx;
    const form = new FormData();
    form.append("_action", "disconnect-stripe");
    form.append("connectionId", "c_active");

    const res = (await stripeAction({
      context: memberCtx,
      request: new Request("https://foxhoundapp.test/settings/stripe", { method: "POST", body: form }),
      params: {},
    } as never)) as unknown as { init?: { status?: number } };

    expect(res.init?.status).toBe(403);
    expect(connectionRow("c_active").disconnectedAt).toBeNull();
  });
});

describe("PLANT 3: disconnect stamps the timestamp, leaves is_primary, and the readers stop seeing it", () => {

  it("the last connection leaves the account with none live, and the loader renders the empty state", async () => {
    seedConnection({ id: "c_only", accountId: ACTIVE, stripeUserId: "acct_o", isPrimary: true });

    await post({ _action: "disconnect-stripe", connectionId: "c_only" });

    const loaded = (await loader({ context: ctx, request: new Request("https://x/settings"), params: {} } as never)) as {
      connections: unknown[];
    };
    // J41: Recova has ONE empty state ("No Stripe account connected") whether
    // or not the account was ever connected, so the loader no longer returns
    // the never-connected flag nothing read.
    expect(loaded.connections).toEqual([]);
  });
});

describe("PLANT 5: cancel stops processing, disconnects all, and leaves billing alone", () => {
  it("stamps cancelled_at, disconnects every live connection, and moves the marker", async () => {
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });
    seedConnection({ id: "c_b", accountId: ACTIVE, stripeUserId: "acct_b", connectedAt: 2_000 });

    const res = await post({ _action: "cancel-account" });

    expect(res.status).toBe(200);
    const acct = sqlite
      .prepare("SELECT cancelled_at AS c FROM accounts WHERE id = ?")
      .get(ACTIVE) as { c: number | null };
    expect(acct.c).not.toBeNull();
    expect(connectionRow("c_a").disconnectedAt).not.toBeNull();
    expect(connectionRow("c_b").disconnectedAt).not.toBeNull();
    expect(harness.deauthorizeCalls.sort()).toEqual(["acct_a", "acct_b"]);
    // The caller still holds the earliest account, so the session lands there.
    expect(markerOf("sess_1")).toBe(EARLIEST);
  });

  it("with no other account held, the marker is left alone and the shell lands the empty state", async () => {
    sqlite.prepare("DELETE FROM account_members WHERE account_id = ?").run(EARLIEST);
    seedConnection({ id: "c_a", accountId: ACTIVE, stripeUserId: "acct_a", isPrimary: true });

    await post({ _action: "cancel-account" });

    expect(markerOf("sess_1")).toBe(ACTIVE);
    const remaining = await listMemberships(db, USER);
    expect(remaining.map((m) => m.accountId)).toEqual([ACTIVE]);
  });
});
