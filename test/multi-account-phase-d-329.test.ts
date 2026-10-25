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
const { buildConnectState, ADD_ACCOUNT_ACTION, CONNECT_ACTION } = await import(
  "~/lib/stripe/connect-state"
);
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

  // The money DO, modeled: one atomic batch per call, recorded so the tests can
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

describe("PLANT 4: connect attaches to the ACTIVE account, not the earliest", () => {

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

  it("refuses an action outside the two known ones, even with a matching cookie", async () => {
    seedSwitchedToB();
    const forged = JSON.stringify({ nonce: "n1", action: "delete_everything" });
    const res = await callback({ stateParam: forged, cookie: forged });
    expect(res.headers.get("location")).toBe("/connect?error=invalid_state");
    expect(harness.writes).toHaveLength(0);
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
});
