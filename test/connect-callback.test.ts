import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// The connect callback decides which merchant's ledger a Stripe account's webhooks resolve to. Every refusal must write
// nothing and make no further Stripe call. Two users, not two memberships: a one-user fixture goes green against the defect.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  oauth: null as unknown,
  writes: [] as { accountId: string; idempotencyKey: string; statements: number }[],
  nameFetches: 0,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

vi.mock("~/lib/stripe/connect", () => ({
  exchangeConnectCode: async () => harness.oauth,
  fetchConnectedAccountName: async () => {
    harness.nameFetches += 1;
    return "Connected Co";
  },
  buildConnectAuthorizeUrl: () => "https://connect.stripe.com/oauth/authorize",
  isMerchantConnectScope: (scope: string | null) => scope === "read_write",
}));

vi.mock("~/lib/stripe/encryption", () => ({
  encryptToken: async (_env: unknown, plaintext: string) => `enc(${plaintext})`,
}));

vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));

const { executeMoneyWrite } = await import("~/lib/money/execute");
const { loader } = await import("~/routes/auth/connect-callback");
const { buildConnectState, ADD_ACCOUNT_ACTION, CONNECT_ACTION } =
  await import("~/lib/stripe/connect-state");
const { STRIPE_OAUTH_STATE_COOKIE } = await import("~/lib/stripe/constants");

const USER = "user_1";
const OTHER = "user_2";
const STRIPE_X = "acct_stripe_x";
const ACCOUNT_A = "acct_a";
const ACCOUNT_B = "acct_b";
const SESSION_B = "sess_b";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.session = null;
  harness.writes = [];
  harness.nameFetches = 0;
  harness.oauth = {
    stripeUserId: STRIPE_X,
    accessToken: "sk_live_plain",
    publishableKey: "pk_live",
    scope: "read_write",
  };

  vi.mocked(executeMoneyWrite).mockImplementation(async (_env, write) => {
    const statements = write.build(db);
    harness.writes.push({
      accountId: write.accountId,
      idempotencyKey: write.idempotencyKey,
      statements: statements.length,
    });
    sqlite.transaction(() => {
      for (const stmt of statements) runStatement(sqlite, stmt);
    })();
    return { applied: true };
  });

  seedUser(USER, "owner@acme.test");
  seedUser(OTHER, "other@globex.test");
  // ACCOUNT_A belongs to user 1 and already holds Stripe account X, live.
  seedAccount(ACCOUNT_A, "Acme");
  seedMembership("m_a", ACCOUNT_A, USER);
  // ACCOUNT_B belongs to user 2, a different person, with nothing attached.
  seedAccount(ACCOUNT_B, "Globex", 2_000);
  seedMembership("m_b", ACCOUNT_B, OTHER, 2_000);
});

function seedUser(id: string, email: string): void {
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)",
    )
    .run(id, id, email);
}

function seedAccount(id: string, name: string, createdAt = 1_000): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, createdAt);
}

function seedMembership(id: string, accountId: string, userId: string, createdAt = 1_000): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    )
    .run(id, accountId, userId, createdAt);
}

function seedConnection(opts: {
  id: string;
  accountId: string;
  stripeUserId: string;
  disconnectedAt?: number | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, 1, 1000, ?, 1000)",
    )
    .run(opts.id, opts.accountId, opts.stripeUserId, opts.disconnectedAt ?? null);
}

function signIn(sessionId: string, userId: string, activeAccountId: string | null): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(sessionId, 9_999_999_999_999, `tok_${sessionId}`, userId, activeAccountId);
  harness.session = {
    user: { id: userId, name: userId, email: `${userId}@test.test` },
    session: { id: sessionId, activeAccountId },
  };
}

function connections(): { id: string; accountId: string; stripeUserId: string }[] {
  return sqlite
    .prepare(
      "SELECT id, account_id AS accountId, stripe_user_id AS stripeUserId FROM stripe_connections ORDER BY rowid",
    )
    .all() as { id: string; accountId: string; stripeUserId: string }[];
}

function markerOf(sessionId: string): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(sessionId) as { m: string | null } | undefined;
  return row?.m ?? null;
}

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return {
        env: {} as Env,
        ctx: { waitUntil: () => {} } as unknown as ExecutionContext,
      };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof loader>[0]["context"];

/** Run the callback with a state that was really minted for `action`; `opts`
 *  replaces the state param, the cookie, or the code. */
async function callback(
  action: string,
  opts: { state?: string; cookie?: string; code?: string | null } = {},
): Promise<Response> {
  const minted = buildConnectState(
    action as never,
    (harness.session as { user: { id: string } } | null)?.user.id ?? null,
  );
  const state = opts.state ?? minted;
  const url = new URL("https://foxhoundapp.test/connect/callback");
  if (opts.code !== null) url.searchParams.set("code", opts.code ?? "ac_123");
  url.searchParams.set("state", state);
  const headers = new Headers();
  headers.set("cookie", `${STRIPE_OAUTH_STATE_COOKIE}=${opts.cookie ?? minted}`);
  try {
    return (await loader({
      context: fakeContext,
      request: new Request(url, { headers }),
      params: {},
    } as never)) as unknown as Response;
  } catch (thrown) {
    return thrown as Response;
  }
}

function errorParam(response: Response): string | null {
  return new URL(
    response.headers.get("location") ?? "",
    "https://foxhoundapp.test",
  ).searchParams.get("error");
}

describe("a Stripe account live on another person's account is refused in the connect branch", () => {
  it("refuses user 2 connecting a Stripe account live on user 1's account", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, OTHER, ACCOUNT_B);

    const response = await callback(CONNECT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(connections()).toEqual([{ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X }]);
    expect(harness.writes).toEqual([]);
    expect(harness.nameFetches).toBe(0);
  });
});

describe("the same refusal in the add_account branch", () => {
  it("refuses user 2 adding an account around a Stripe account live on user 1's", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, OTHER, ACCOUNT_B);

    const response = await callback(ADD_ACCOUNT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(connections()).toEqual([{ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X }]);
    // The branch that mints a whole account must not have minted one.
    expect(harness.writes).toEqual([]);
    expect(harness.nameFetches).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).toEqual({
      n: 2,
    });
  });
});

describe("the same user's own second account is refused too", () => {
  it("refuses connecting to B a Stripe account live on A when one user holds both", async () => {
    // Moving a live connection between one merchant's ledgers would re-point every future webhook.
    sqlite.prepare("UPDATE account_members SET user_id = ? WHERE id = 'm_b'").run(USER);
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, USER, ACCOUNT_B);

    const response = await callback(CONNECT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(harness.writes).toEqual([]);
  });
});

describe("the unique index refuses a connection that went live after the read", () => {
  it("bounces add_account and leaves the session where it was when the write is refused", async () => {
    signIn(SESSION_B, OTHER, ACCOUNT_B);
    // Another account connects Stripe account X between the predicate's read
    // and this callback's write, so only the index can refuse it.
    vi.mocked(executeMoneyWrite).mockImplementationOnce(async (_env, write) => {
      seedConnection({ id: "conn_race", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
      const statements = write.build(db);
      sqlite.transaction(() => {
        for (const stmt of statements) runStatement(sqlite, stmt);
      })();
      return { applied: true };
    });

    const response = await callback(ADD_ACCOUNT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(markerOf(SESSION_B)).toBe(ACCOUNT_B);
    expect(connections()).toEqual([
      { id: "conn_race", accountId: ACCOUNT_A, stripeUserId: STRIPE_X },
    ]);
  });
});

describe("the cases that must still succeed", () => {
  it("add_account for a Stripe account the caller already holds redirects and writes nothing", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn("sess_a", USER, ACCOUNT_A);

    const response = await callback(ADD_ACCOUNT_ACTION);

    expect(errorParam(response)).toBeNull();
    // Nothing new was connected, so not the welcome page.
    expect(response.headers.get("location")).toBe("/console");
    expect(harness.writes).toEqual([]);
    expect(connections()).toHaveLength(1);
    expect(markerOf("sess_a")).toBe(ACCOUNT_A);
  });

  it("a reconnect on the ACTIVE account updates in place rather than inserting", async () => {
    // The row carries per-connection settings, so an insert would silently reset them.
    seedConnection({
      id: "conn_a",
      accountId: ACCOUNT_A,
      stripeUserId: STRIPE_X,
      disconnectedAt: 2_000,
    });
    signIn("sess_a", USER, ACCOUNT_A);

    const response = await callback(CONNECT_ACTION);

    expect(connections()).toEqual([{ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X }]);
    expect(response.headers.get("location")).toBe("/console");
    expect(
      sqlite
        .prepare("SELECT disconnected_at AS d FROM stripe_connections WHERE id = 'conn_a'")
        .get() as { d: number | null },
    ).toEqual({ d: null });
  });

  it("a Stripe account disconnected elsewhere attaches here", async () => {
    seedConnection({
      id: "conn_a",
      accountId: ACCOUNT_A,
      stripeUserId: STRIPE_X,
      disconnectedAt: 2_000,
    });
    signIn(SESSION_B, OTHER, ACCOUNT_B);

    const response = await callback(CONNECT_ACTION);

    expect(connections().map((c) => [c.accountId, c.stripeUserId])).toEqual([
      [ACCOUNT_A, STRIPE_X],
      [ACCOUNT_B, STRIPE_X],
    ]);
    expect(response.headers.get("location")).toBe(`/welcome?connection=${connections()[1].id}`);
  });
});

describe("only the owner who started a flow may finish it, and only with a write grant", () => {
  it("refuses an action outside the two known ones, even with a matching cookie", async () => {
    signIn(SESSION_B, OTHER, ACCOUNT_B);
    const forged = JSON.stringify({ nonce: "n1", action: "delete_everything" });
    const response = await callback(CONNECT_ACTION, { state: forged, cookie: forged });
    expect(errorParam(response)).toBe("invalid_state");
    expect(harness.writes).toEqual([]);
  });

  it("refuses a state minted for a different user in the same browser", async () => {
    signIn(SESSION_B, OTHER, ACCOUNT_B);
    const theirs = buildConnectState(CONNECT_ACTION, USER);
    const response = await callback(CONNECT_ACTION, { state: theirs, cookie: theirs });
    expect(errorParam(response)).toBe("invalid_state");
    expect(harness.writes).toEqual([]);
  });

  it("refuses a member of the active account who is not its owner", async () => {
    sqlite.prepare("UPDATE account_members SET role = 'member' WHERE id = 'm_a'").run();
    signIn("sess_a", USER, ACCOUNT_A);
    const response = await callback(CONNECT_ACTION);
    expect(errorParam(response)).toBe("owner_required");
    expect(connections()).toEqual([]);
  });

  it("refuses a grant without the write scope", async () => {
    signIn("sess_a", USER, ACCOUNT_A);
    harness.oauth = { ...(harness.oauth as object), scope: "read_only" };
    const response = await callback(CONNECT_ACTION);
    expect(errorParam(response)).toBe("scope_refused");
    expect(harness.writes).toEqual([]);
  });
});

describe("the writes the callback makes", () => {
  it("add_account is one money write of three statements, keyed on the account it creates", async () => {
    signIn("sess_a", USER, ACCOUNT_A);

    await callback(ADD_ACCOUNT_ACTION);

    const created = (
      sqlite
        .prepare("SELECT id FROM accounts WHERE id NOT IN (?, ?)")
        .get(ACCOUNT_A, ACCOUNT_B) as {
        id: string;
      }
    ).id;
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].accountId).toBe(created);
    expect(harness.writes[0].idempotencyKey).toBe(`add-account:${created}`);
    // Account, connection, membership.
    expect(harness.writes[0].statements).toBe(3);
  });
});

describe("the database refuses a second live connection for one Stripe account", () => {
  const insertConnection = (id: string, accountId: string, stripeUserId: string, disc?: number) =>
    seedConnection({ id, accountId, stripeUserId, disconnectedAt: disc });

  it("refuses it on another Foxhound account, and on the same one", () => {
    insertConnection("conn_a", ACCOUNT_A, STRIPE_X);
    expect(() => insertConnection("conn_b", ACCOUNT_B, STRIPE_X)).toThrow(/unique/i);
    expect(() => insertConnection("conn_a2", ACCOUNT_A, STRIPE_X)).toThrow(/unique/i);
    expect(connections().map((c) => c.id)).toEqual(["conn_a"]);
  });

  it("a disconnected row never blocks a live one, however many there are", () => {
    insertConnection("c1", ACCOUNT_A, STRIPE_X, 1);
    insertConnection("c2", ACCOUNT_A, STRIPE_X, 2);
    expect(() => insertConnection("c3", ACCOUNT_B, STRIPE_X)).not.toThrow();
  });
});
