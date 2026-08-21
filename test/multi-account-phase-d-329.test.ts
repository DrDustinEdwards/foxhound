import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Phase (d) of the multi-account build (ruling 329): the callback branches on
// the state's own action, `add_account` mints a whole new account, `connect`
// attaches to the ACTIVE one, and the double-submit debt 327 named is paid.
//
// THIS IS THE MONEY PATH. `stripe_connections` decides which merchant's ledger
// every future webhook for a Stripe account resolves to, and
// parity/MULTI-ACCOUNT-QUERY-AUDIT.md names this file's subject the single
// riskiest query in the codebase. So the assertions here are about WHICH account
// each row lands on, and every branch that refuses is checked for having written
// nothing, not just for its redirect.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  oauth: null as unknown,
  writes: [] as { accountId: string; idempotencyKey: string; statements: number }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

vi.mock("~/lib/stripe/connect", () => ({
  exchangeConnectCode: async () => harness.oauth,
  fetchConnectedAccountName: async () => "Connected Co",
  buildConnectAuthorizeUrl: () => "https://connect.stripe.com/oauth/authorize",
}));

vi.mock("~/lib/stripe/encryption", () => ({
  encryptToken: async (_env: unknown, plaintext: string) => `enc(${plaintext})`,
}));

vi.mock("~/lib/money/execute", () => ({ executeMoneyWrite: vi.fn() }));

const { executeMoneyWrite } = await import("~/lib/money/execute");
const { loader } = await import("~/routes/auth/connect-callback");
const { verifyConnectState, buildConnectState, ADD_ACCOUNT_ACTION, CONNECT_ACTION } = await import(
  "~/lib/stripe/connect-state"
);
const { bindSwitcherDismiss } = await import("~/components/nav/account-switcher");
const schema = await import("~/db/schema");
const { STRIPE_OAUTH_STATE_COOKIE } = await import("~/lib/constants");

const USER = "user_1";
const OTHER = "user_2";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.session = null;
  harness.oauth = {
    stripeUserId: "acct_NEW",
    accessToken: "sk_live_plain",
    publishableKey: "pk_live",
    scope: "read_write",
  };
  harness.writes = [];

  // The money DO, modelled: one atomic batch per call, recorded so the tests can
  // assert HOW MANY writes happened and what each was keyed on.
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
  seedUser(OTHER, "other@acme.test");
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

function seedConnection(id: string, accountId: string, stripeUserId: string): void {
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, created_at) VALUES (?, ?, ?, 1, 1000)",
    )
    .run(id, accountId, stripeUserId);
}

function seedSession(id: string, activeAccountId: string | null, userId = USER): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(id, 9_999_999_999_999, `tok_${id}`, userId, activeAccountId);
  harness.session = {
    user: { id: userId, name: userId, email: `${userId}@acme.test` },
    session: { id, activeAccountId },
  };
}

function markerOf(sessionId: string): string | null {
  const row = sqlite
    .prepare("SELECT active_account_id AS m FROM session WHERE id = ?")
    .get(sessionId) as { m: string | null } | undefined;
  return row?.m ?? null;
}

function connections(): { accountId: string; stripeUserId: string }[] {
  return sqlite
    .prepare("SELECT account_id AS accountId, stripe_user_id AS stripeUserId FROM stripe_connections")
    .all() as { accountId: string; stripeUserId: string }[];
}

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof loader>[0]["context"];

/** Run the callback with a state that was really minted for `action`. */
async function callback(opts: {
  action?: string;
  stateParam?: string;
  cookie?: string | null;
  code?: string | null;
}): Promise<Response> {
  const minted = opts.action ? buildConnectState(opts.action as never) : null;
  const stateParam = opts.stateParam ?? minted;
  const cookie = opts.cookie === undefined ? minted : opts.cookie;
  const url = new URL("https://foxhoundapp.test/connect/callback");
  if (opts.code !== null) url.searchParams.set("code", opts.code ?? "ac_123");
  if (stateParam) url.searchParams.set("state", stateParam);

  const headers = new Headers();
  if (cookie) headers.set("cookie", `${STRIPE_OAUTH_STATE_COOKIE}=${cookie}`);

  try {
    return (await loader({
      context: fakeContext,
      request: new Request(url, { headers }),
      params: {},
    } as never)) as unknown as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** One user, two held accounts, switched to the LATER one. */
function seedSwitchedToB(): void {
  seedAccount("acct_a", "Acme", 1_000);
  seedAccount("acct_b", "Globex", 2_000);
  seedMembership("m1", "acct_a", USER, 1_000);
  seedMembership("m2", "acct_b", USER, 2_000);
  seedSession("sess_1", "acct_b");
}

describe("PLANT 1: add_account mints a new account and attaches only there", () => {
  it("creates a THIRD account, attaches the Stripe account to it alone, and marks it", async () => {
    seedSwitchedToB();

    const res = await callback({ action: ADD_ACCOUNT_ACTION });

    expect(res.status).toBe(302);

    const accounts = sqlite.prepare("SELECT id, name FROM accounts").all() as {
      id: string;
      name: string;
    }[];
    expect(accounts).toHaveLength(3);
    const created = accounts.find((a) => a.id !== "acct_a" && a.id !== "acct_b")!;
    expect(created.name).toBe("Connected Co");

    // ONLY there. Neither held account gained a connection.
    expect(connections()).toEqual([{ accountId: created.id, stripeUserId: "acct_NEW" }]);

    // The owner membership landed with it.
    const members = sqlite
      .prepare("SELECT account_id AS a FROM account_members WHERE user_id = ? AND status = 'active'")
      .all(USER) as { a: string }[];
    expect(members.map((m) => m.a).sort()).toEqual(["acct_a", "acct_b", created.id].sort());

    // THE MARKER MOVES TO THE NEW ACCOUNT, not back to the earliest. A mutation
    // that lands the caller on memberships[0] passes every assertion above and
    // fails this one, which is why it is separate.
    expect(markerOf("sess_1")).toBe(created.id);
    expect(markerOf("sess_1")).not.toBe("acct_a");
  });
});

describe("PLANT 7: the whole of add_account is ONE money write, keyed on the new account", () => {
  it("commits exactly one batch of three statements, keyed on the account it creates", async () => {
    seedSwitchedToB();

    await callback({ action: ADD_ACCOUNT_ACTION });

    const created = (
      sqlite.prepare("SELECT id FROM accounts WHERE id NOT IN ('acct_a','acct_b')").get() as {
        id: string;
      }
    ).id;

    expect(harness.writes).toHaveLength(1);
    // Keyed on the NEW account: the DO is named by this id, so the id has to be
    // minted before the write that creates the row it names. Keying on the
    // caller's active account would serialize the wrong partition.
    expect(harness.writes[0].accountId).toBe(created);
    expect(harness.writes[0].idempotencyKey).toBe(`add-account:${created}`);
    // Account, connection, membership. A mutation that moves the
    // stripe_connections insert out of the batch drops this to 2 and leaves a
    // window where the account exists with no connection.
    expect(harness.writes[0].statements).toBe(3);
  });
});

describe("PLANT 2: a Stripe account already on an account the user holds", () => {
  it("redirects there, creates nothing, and moves the marker", async () => {
    seedSwitchedToB();
    seedConnection("c_existing", "acct_a", "acct_NEW");

    const res = await callback({ action: ADD_ACCOUNT_ACTION });

    expect(res.status).toBe(302);
    // NOTHING written: no third account, no second connection, no money write.
    expect(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 2 });
    expect(connections()).toHaveLength(1);
    expect(harness.writes).toHaveLength(0);
    // They asked to go to that Stripe account, so take them to it.
    expect(markerOf("sess_1")).toBe("acct_a");
  });
});

describe("PLANT 3: a Stripe account on an account the user does NOT hold", () => {
  it("creates nothing and refuses without naming the other account", async () => {
    seedSwitchedToB();
    seedAccount("acct_theirs", "Someone else", 3_000);
    seedMembership("m9", "acct_theirs", OTHER, 3_000);
    seedConnection("c_theirs", "acct_theirs", "acct_NEW");

    const res = await callback({ action: ADD_ACCOUNT_ACTION });

    const location = res.headers.get("location")!;
    expect(location).toBe("/connect?error=stripe_account_already_connected");
    // The refusal must not leak WHICH account, or even that it is somebody
    // else's: whoever controls the Stripe account would learn another
    // merchant's tenancy.
    expect(location).not.toContain("acct_theirs");
    expect(location).not.toContain("Someone else");

    expect(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 3 });
    expect(connections()).toHaveLength(1);
    expect(harness.writes).toHaveLength(0);
    expect(markerOf("sess_1")).toBe("acct_b");
  });
});

describe("PLANT 4: connect attaches to the ACTIVE account, not the earliest", () => {
  it("lands the connection on the account the caller switched to", async () => {
    // THE PHASE (e) HAZARD, as an assertion. connect-callback.ts resolved with
    // the null-marker shim and would have attached to acct_a here, permanently,
    // with every future webhook for acct_NEW resolving to the wrong ledger.
    seedSwitchedToB();

    const res = await callback({ action: CONNECT_ACTION });

    expect(res.status).toBe(302);
    expect(connections()).toEqual([{ accountId: "acct_b", stripeUserId: "acct_NEW" }]);
    expect(harness.writes[0].accountId).toBe("acct_b");
    // No new account: connect attaches, it does not mint.
    expect(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 2 });
  });

  it("falls back to the earliest only when there is no marker", async () => {
    seedAccount("acct_a", "Acme", 1_000);
    seedAccount("acct_b", "Globex", 2_000);
    seedMembership("m1", "acct_a", USER, 1_000);
    seedMembership("m2", "acct_b", USER, 2_000);
    seedSession("sess_1", null);

    await callback({ action: CONNECT_ACTION });

    expect(connections()).toEqual([{ accountId: "acct_a", stripeUserId: "acct_NEW" }]);
  });

  it("refuses to MOVE a connection that sits on another account the user holds", async () => {
    // Legacy's upsert is keyed `onConflict: 'stripe_user_id'` and would move it,
    // silently re-attributing every future recovery. Not a leak (they own both)
    // and not a reconnect either.
    seedSwitchedToB();
    seedConnection("c_on_a", "acct_a", "acct_NEW");

    const res = await callback({ action: CONNECT_ACTION });

    expect(res.headers.get("location")).toBe("/connect?error=stripe_account_already_connected");
    expect(connections()).toEqual([{ accountId: "acct_a", stripeUserId: "acct_NEW" }]);
    expect(harness.writes).toHaveLength(0);
  });

  it("still reconnects in place when the connection is on the ACTIVE account", async () => {
    seedSwitchedToB();
    seedConnection("c_on_b", "acct_b", "acct_NEW");

    await callback({ action: CONNECT_ACTION });

    expect(connections()).toHaveLength(1);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].statements).toBe(1); // the UPDATE, not an INSERT
  });
});

describe("PLANT 5: an unminted or unknown state is refused before any write", () => {
  it("refuses a state the cookie does not match", async () => {
    seedSwitchedToB();
    const res = await callback({
      action: ADD_ACCOUNT_ACTION,
      stateParam: buildConnectState(ADD_ACCOUNT_ACTION),
      cookie: buildConnectState(ADD_ACCOUNT_ACTION),
    });
    // Two independently minted payloads carry different nonces, so this is the
    // "did we mint THIS one" case.
    expect(res.headers.get("location")).toBe("/connect?error=invalid_state");
    expect(harness.writes).toHaveLength(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()).toEqual({ n: 2 });
  });

  it("refuses an action outside the two known ones, even with a matching cookie", async () => {
    seedSwitchedToB();
    const forged = JSON.stringify({ nonce: "n1", action: "delete_everything" });
    const res = await callback({ stateParam: forged, cookie: forged });
    expect(res.headers.get("location")).toBe("/connect?error=invalid_state");
    expect(harness.writes).toHaveLength(0);
  });

  it("refuses a bare uuid state, the pre-phase-(d) shape", async () => {
    seedSwitchedToB();
    const bare = "6f1c9b1e-0000-4000-8000-000000000000";
    const res = await callback({ stateParam: bare, cookie: bare });
    expect(res.headers.get("location")).toBe("/connect?error=invalid_state");
    expect(harness.writes).toHaveLength(0);
  });

  it("refuses with no cookie at all", async () => {
    seedSwitchedToB();
    const res = await callback({ action: ADD_ACCOUNT_ACTION, cookie: null });
    expect(res.headers.get("location")).toBe("/connect?error=invalid_state");
    expect(harness.writes).toHaveLength(0);
  });

  it("verifyConnectState is the whole decision, and it is strict", () => {
    const minted = buildConnectState(CONNECT_ACTION);
    expect(verifyConnectState(minted, minted)).toBe(CONNECT_ACTION);
    expect(verifyConnectState(minted, buildConnectState(CONNECT_ACTION))).toBeNull();
    expect(verifyConnectState(null, minted)).toBeNull();
    expect(verifyConnectState(minted, null)).toBeNull();
    // THE ESCALATION THIS EXISTS FOR: same nonce, action rewritten in the URL.
    // Comparing parsed nonces instead of raw strings would let this through and
    // mint a whole new account from a plain connect flow.
    const connectState = buildConnectState(CONNECT_ACTION, "shared-nonce");
    const upgraded = buildConnectState(ADD_ACCOUNT_ACTION, "shared-nonce");
    expect(verifyConnectState(upgraded, connectState)).toBeNull();
  });

  it("the state check runs before the code is exchanged", async () => {
    // No code at all, and a good state: the no_code bounce proves ordering only
    // if the reverse also holds, so this pairs with the case above.
    seedSwitchedToB();
    const res = await callback({ action: ADD_ACCOUNT_ACTION, code: null });
    expect(res.headers.get("location")).toBe("/connect?error=no_code");
    expect(harness.writes).toHaveLength(0);
  });
});

describe("PLANT 8: Escape closes the menu, and outside mousedown still does", () => {
  function recorder() {
    const handlers = new Map<string, (e: unknown) => void>();
    const removed: string[] = [];
    const target = {
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      removeEventListener: (type: string) => removed.push(type),
    } as unknown as Document;
    return { handlers, removed, target };
  }

  it("Escape closes", () => {
    const { handlers, target } = recorder();
    let closed = 0;
    bindSwitcherDismiss({ target, isInside: () => false, close: () => (closed += 1) });
    handlers.get("keydown")!({ key: "Escape" });
    expect(closed).toBe(1);
  });

  it("another key does not, which is what makes the first case discriminate", () => {
    const { handlers, target } = recorder();
    let closed = 0;
    bindSwitcherDismiss({ target, isInside: () => false, close: () => (closed += 1) });
    handlers.get("keydown")!({ key: "Enter" });
    handlers.get("keydown")!({ key: "Esc" });
    expect(closed).toBe(0);
  });

  it("legacy's outside mousedown still closes, and an inside one does not", () => {
    const { handlers, target } = recorder();
    let closed = 0;
    let inside = false;
    bindSwitcherDismiss({ target, isInside: () => inside, close: () => (closed += 1) });

    handlers.get("mousedown")!({ target: {} });
    expect(closed).toBe(1);

    inside = true;
    handlers.get("mousedown")!({ target: {} });
    expect(closed).toBe(1);
  });

  it("teardown removes BOTH listeners, so neither outlives the open state", () => {
    const { removed, target } = recorder();
    bindSwitcherDismiss({ target, isInside: () => false, close: () => {} })();
    expect(removed.sort()).toEqual(["keydown", "mousedown"]);
  });
});

describe("the connect flow marks its own state now", () => {
  it("both mint sites use the shared builder, so neither can go unmarked", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (p: string) =>
      readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8").replace(
        /^\s*\/\/.*$/gm,
        "",
      );

    expect(read("../app/routes/auth/connect.tsx")).toContain(
      "buildConnectState(CONNECT_ACTION)",
    );
    expect(read("../app/routes/auth/connect-additional.ts")).toContain(
      "buildConnectState(ADD_ACCOUNT_ACTION)",
    );
    // A bare uuid state would be refused by the callback now, so a mint site
    // that regressed to one would break the flow rather than silently pick a
    // branch. Asserted anyway: the failure should be visible here, not in an
    // OAuth round trip.
    expect(read("../app/routes/auth/connect.tsx")).not.toContain(
      "const state = crypto.randomUUID()",
    );
  });

  it("the fail-closed guard phase (e) needed is gone with its error param", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../app/routes/auth/connect-additional.ts", import.meta.url)),
      "utf8",
    );
    // Scoped to the code, since the comment explains the retirement by name.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("add_account_unavailable");
    expect(code).not.toContain("resolveMembership");
  });

  it("the callback no longer resolves with the null-marker shim", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../app/routes/auth/connect-callback.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("resolveActiveMembershipFrom");
    // `resolveMembership` is the shim; its name is a prefix of nothing else in
    // this file, so a plain absence check is exact here.
    expect(code).not.toMatch(/\bresolveMembership\b/);
  });
});

describe("nothing about the demo firewall or the money DO semantics moved", () => {
  it("the callback writes only through executeMoneyWrite", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const code = readFileSync(
      fileURLToPath(new URL("../app/routes/auth/connect-callback.ts", import.meta.url)),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // No direct insert/update on the db handle: every mutation is inside a
    // build callback handed to the DO. `setSessionActiveAccount` is the one
    // non-money write and it lives in its own module.
    expect(code).not.toMatch(/\bdb\s*\.\s*insert\b/);
    expect(code).not.toMatch(/\bdb\s*\.\s*update\b/);
    expect(code).not.toMatch(/\bdb\s*\.\s*batch\b/);
  });

  it("the schema still refuses a duplicate active pair, which is the surviving backstop", () => {
    seedAccount("acct_a", "Acme");
    seedMembership("m1", "acct_a", USER);
    expect(() => seedMembership("m2", "acct_a", USER)).toThrow(/UNIQUE constraint failed/i);
  });

  it("account_products is still absent, so add_account creating none is correct", () => {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("account_products");
    expect(tables.map((t) => t.name)).toContain("stripe_connections");
    void schema;
  });
});
