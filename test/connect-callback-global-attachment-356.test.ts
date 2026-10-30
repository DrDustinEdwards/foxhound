import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 356 BINDING 2, DEFECT 4: ONE predicate, used by BOTH callback branches.
//
// THE DEFECT THIS FILE REPRODUCES. `attachToActiveAccount`'s attached-elsewhere
// lookup was scoped `inArray(accountId, memberships)`, so it could only see the
// caller's OWN accounts. A Stripe account live on a stranger's Foxhound account
// therefore read as unattached, a second live row was written, and
// `resolveConnection` routed that Stripe account's failed payments, recovered
// payments and billing line items to whichever row came first. `addAccount`'s
// equivalent check was already global, so the two branches disagreed.
//
// TWO USERS, NOT TWO MEMBERSHIPS. The reproduction needs two
// PEOPLE who both hold Stripe access to one connected account; a fixture with
// one user holding two accounts exercises the case the old scoped query already
// caught, and would have gone green against the defect.
//
// THE REFUSAL IS CHECKED FOR HAVING WRITTEN NOTHING and for having made no
// further Stripe call, not just for its redirect. `fetchConnectedAccountName` is
// counted for exactly that reason: it is the one network call the branches make
// after the token exchange, so a refusal that happens too late shows up here.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  oauth: null as unknown,
  writes: [] as { accountId: string; idempotencyKey: string }[],
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
// MOVED IN PHASE (f) to app/lib/stripe/connections.server.ts. The predicate is
// unchanged and is still the one definition all three callers share; it left the
// route module because the audit's live results page needs it and a `.tsx` route
// importing a route module drags the database onto its client graph. The
// dot-server build guard refuses a re-export from a route module, so the import
// path moves with the code rather than being papered over.
const { findLiveAttachment } = await import("~/lib/stripe/connections.server");
const { buildConnectState, ADD_ACCOUNT_ACTION, CONNECT_ACTION } = await import(
  "~/lib/stripe/connect-state"
);
const { STRIPE_OAUTH_STATE_COOKIE } = await import("~/lib/constants");

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
    harness.writes.push({ accountId: write.accountId, idempotencyKey: write.idempotencyKey });
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
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
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
  const row = sqlite.prepare("SELECT active_account_id AS m FROM session WHERE id = ?").get(sessionId) as
    | { m: string | null }
    | undefined;
  return row?.m ?? null;
}

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return { env: {} as Env, ctx: { waitUntil: () => {} } as unknown as ExecutionContext, nonce: "n" };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof loader>[0]["context"];

async function callback(action: string): Promise<Response> {
  const minted = buildConnectState(action as never, (harness.session as { user: { id: string } } | null)?.user.id ?? null);
  const url = new URL("https://foxhoundapp.test/connect/callback");
  url.searchParams.set("code", "ac_123");
  url.searchParams.set("state", minted);
  const headers = new Headers();
  headers.set("cookie", `${STRIPE_OAUTH_STATE_COOKIE}=${minted}`);
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
  return new URL(response.headers.get("location") ?? "", "https://foxhoundapp.test").searchParams.get(
    "error",
  );
}

describe("PLANT 1: the predicate itself, three discriminated answers", () => {
  it("answers unattached, held_by_caller and held_elsewhere, never a nullable id", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });

    await expect(findLiveAttachment(db, "acct_stripe_unknown", [ACCOUNT_B])).resolves.toEqual({
      status: "unattached",
    });
    await expect(findLiveAttachment(db, STRIPE_X, [ACCOUNT_A])).resolves.toEqual({
      status: "held_by_caller",
      accountId: ACCOUNT_A,
    });
    await expect(findLiveAttachment(db, STRIPE_X, [ACCOUNT_B])).resolves.toEqual({
      status: "held_elsewhere",
    });
  });
});

describe("PLANT 2: DEFECT 4's reproduction is refused in the connect branch", () => {
  it("refuses user 2 connecting a Stripe account live on user 1's account", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, OTHER, ACCOUNT_B);

    const response = await callback(CONNECT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    // Nothing written, and the assertion is on the TABLE, not on the redirect.
    expect(connections()).toEqual([
      { id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X },
    ]);
    expect(harness.writes).toEqual([]);
    // And no further Stripe call: the refusal lands before the account-name
    // fetch, so a merchant who is going to be refused is not a request Foxhound
    // makes on their behalf.
    expect(harness.nameFetches).toBe(0);
  });
});

describe("PLANT 3: the same refusal in the add_account branch", () => {
  it("refuses user 2 adding an account around a Stripe account live on user 1's", async () => {
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, OTHER, ACCOUNT_B);

    const response = await callback(ADD_ACCOUNT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(connections()).toEqual([
      { id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X },
    ]);
    // The branch that mints a whole account must not have minted one.
    expect(harness.writes).toEqual([]);
    expect(harness.nameFetches).toBe(0);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number },
    ).toEqual({ n: 2 });
  });
});

describe("PLANT 4: the same user's own second account is refused too, unchanged", () => {
  it("refuses connecting to B a Stripe account live on A when one user holds both", async () => {
    // The case the OLD scoped query did catch. It must keep being refused:
    // moving a live connection between two of one merchant's ledgers re-points
    // every future webhook and re-attributes the recoveries it produces.
    sqlite.prepare("UPDATE account_members SET user_id = ? WHERE id = 'm_b'").run(USER);
    seedConnection({ id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X });
    signIn(SESSION_B, USER, ACCOUNT_B);

    const response = await callback(CONNECT_ACTION);

    expect(errorParam(response)).toBe("stripe_account_already_connected");
    expect(harness.writes).toEqual([]);
  });
});

describe("PLANT 4b: the unique index refuses a connection that went live after the read", () => {
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
    expect(connections()).toEqual([{ id: "conn_race", accountId: ACCOUNT_A, stripeUserId: STRIPE_X }]);
  });
});

describe("PLANT 5: the cases that must still SUCCEED", () => {
  it("330 binding 2 is unchanged: add_account for a Stripe account the caller already holds redirects and writes nothing", async () => {
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
    // The row carries per-connection settings (sender name, the four brand
    // voices), so reviving it matters: an insert would silently reset them.
    seedConnection({
      id: "conn_a",
      accountId: ACCOUNT_A,
      stripeUserId: STRIPE_X,
      disconnectedAt: 2_000,
    });
    signIn("sess_a", USER, ACCOUNT_A);

    const response = await callback(CONNECT_ACTION);

    expect(connections()).toEqual([
      { id: "conn_a", accountId: ACCOUNT_A, stripeUserId: STRIPE_X },
    ]);
    // Recova sends a reconnect to /console, never the welcome page (J28, A8).
    expect(response.headers.get("location")).toBe("/console");
    expect(
      sqlite
        .prepare("SELECT disconnected_at AS d FROM stripe_connections WHERE id = 'conn_a'")
        .get() as { d: number | null },
    ).toEqual({ d: null });
  });

  it("a Stripe account DISCONNECTED elsewhere attaches here, which is binding 4 end to end", async () => {
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
    // A new connection lands on /welcome with its id, as Recova's callback
    // sends it (app/api/auth/stripe/callback/route.ts, blob c60331af; J28, A8).
    expect(response.headers.get("location")).toBe(`/welcome?connection=${connections()[1].id}`);
  });
});
