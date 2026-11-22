import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Multi-account: a user holds several accounts, the session carries which one it
// is looking at, a switch action moves it (and decides which account's ledger the
// caller's next money write lands on, so its membership check is tested per way it
// can be wrong), and the switcher lists them.

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
const { listMemberships, resolveActiveMembershipFrom } = await import("~/lib/auth/account");
const { listSwitcherAccounts } = await import("~/lib/nav/accounts.server");
const { ADD_ACCOUNT_ACTION, parseConnectState } = await import("~/lib/stripe/connect-state");
const { accountLabel } = await import("~/components/nav/account-switcher");
const { loader: addAccountLoader } = await import("~/routes/auth/connect-additional");

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
      return { env: {} as Env, ctx: {} as ExecutionContext };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof action>[0]["context"];

function request(opts: {
  method?: string;
  accountId?: string;
  referer?: string;
  json?: boolean;
  emptyForm?: boolean;
}): Request {
  const headers = new Headers();
  if (opts.referer) headers.set("referer", opts.referer);
  let body: BodyInit | undefined;
  if (opts.emptyForm) {
    body = new FormData();
  } else if (opts.accountId !== undefined) {
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

describe("the switch action", () => {
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
    const res = await run({ emptyForm: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing accountId" });
    expect(markerOf("sess_1")).toBeNull();
  });

  it("403 for an account the user does not hold, and the marker does not move", async () => {
    seedTwoAccounts();
    seedAccount("acct_theirs", "Someone else");
    seedMembership({ id: "m9", accountId: "acct_theirs", userId: OTHER_USER });
    signIn("sess_1");

    const res = await run({ accountId: "acct_theirs" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not a member of this account" });
    // Refused AND not written: a 403 that had already moved the marker would be
    // worse than no check at all.
    expect(markerOf("sess_1")).toBeNull();
  });

  it("accepts a JSON body too", async () => {
    seedTwoAccounts();
    signIn("sess_1");
    const res = await run({ accountId: "acct_b", json: true });
    expect(res.status).toBe(302);
    expect(markerOf("sess_1")).toBe("acct_b");
  });
});

describe("safeReturnPath refuses an off-origin referer", () => {
  const SELF = "https://foxhoundapp.test/api/account/switch";

  it("keeps a same-origin path with its query and hash, and sends everything else to /", () => {
    expect(safeReturnPath("https://foxhoundapp.test/billing?tab=invoices#x", SELF)).toBe(
      "/billing?tab=invoices#x",
    );
    // A prefix check would have allowed the lookalike host.
    expect(safeReturnPath("https://foxhoundapp.test.evil.test/steal", SELF)).toBe("/");
    expect(safeReturnPath(null, SELF)).toBe("/");
    expect(safeReturnPath("not a url", SELF)).toBe("/");
    expect(safeReturnPath(SELF, SELF)).toBe("/");
  });
});

describe("active-account resolution", () => {
  it("with no marker, an account carrying last_visited_path beats the earliest", async () => {
    seedAccount("acct_a", "Acme A");
    seedAccount("acct_b", "Acme B", "/recovery/payments");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER, createdAt: 1_000 });
    seedMembership({ id: "m2", accountId: "acct_b", userId: USER, createdAt: 2_000 });

    const memberships = await listMemberships(db, USER);
    const m = await resolveActiveMembershipFrom(db, memberships, null);
    expect(m?.accountId).toBe("acct_b");
  });
});

describe("the membership rule is enforced by the migration", () => {
  const member = (id: string, accountId: string, userId: string | null, status: string) =>
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', ?, 1000)",
      )
      .run(id, accountId, userId, status);

  it("accepts two active memberships for one user on two accounts, refuses a duplicate pair", () => {
    seedAccount("acct_a", "Account A");
    seedAccount("acct_b", "Account B");
    member("m1", "acct_a", USER, "active");
    expect(() => member("m2", "acct_b", USER, "active")).not.toThrow();
    expect(() => member("m3", "acct_a", USER, "active")).toThrow(/UNIQUE constraint failed/i);
  });

  it("stays partial: the same pair is allowed twice when neither row is active", () => {
    // Without the WHERE clause a revoked member could never be re-invited.
    seedAccount("acct_a", "Account A");
    member("m1", "acct_a", USER, "revoked");
    expect(() => member("m2", "acct_a", USER, "revoked")).not.toThrow();
  });
});

describe("the switcher", () => {
  const connect = (id: string, accountId: string, stripeUserId: string) =>
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, created_at) VALUES (?, ?, ?, 1, 1000)",
      )
      .run(id, accountId, stripeUserId);

  it("two memberships yield two rows, each with its own primary stripe_user_id", async () => {
    seedAccount("acct_a", "Acme");
    seedAccount("acct_b", "Globex");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER, createdAt: 1_000 });
    seedMembership({ id: "m2", accountId: "acct_b", userId: USER, createdAt: 2_000 });
    connect("c1", "acct_a", "acct_stripe_A");
    connect("c2", "acct_b", "acct_stripe_B");

    const rows = await listSwitcherAccounts(db, await listMemberships(db, USER));

    expect(rows).toEqual([
      { id: "acct_a", name: "Acme", stripeUserId: "acct_stripe_A" },
      { id: "acct_b", name: "Globex", stripeUserId: "acct_stripe_B" },
    ]);
  });

  it("labels an account by name, else the Stripe account id, else eight characters of its id", () => {
    const id = "abcdefghijkl";
    expect(accountLabel({ id, name: "Acme", stripeUserId: "acct_x" })).toBe("Acme");
    expect(accountLabel({ id, name: null, stripeUserId: "acct_x" })).toBe("acct_x");
    expect(accountLabel({ id, name: null, stripeUserId: null })).toBe("abcdefgh");
    // A blank name falls through rather than rendering an empty row.
    expect(accountLabel({ id, name: "", stripeUserId: "acct_x" })).toBe("acct_x");
  });
});

describe("the add-account route marks its OAuth state", () => {
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) {
        return {
          env: { STRIPE_CLIENT_ID: "ca_test", BETTER_AUTH_URL: "https://foxhoundapp.test" },
          ctx: {} as ExecutionContext,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof addAccountLoader>[0]["context"];

  async function run(): Promise<Response> {
    try {
      return (await addAccountLoader({
        context,
        request: new Request("https://foxhoundapp.test/connect/additional"),
        params: {},
      } as never)) as unknown as Response;
    } catch (thrown) {
      // React Router's redirect() is thrown from a loader.
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }

  it("encodes action add_account into both the state param and the cookie", async () => {
    seedAccount("acct_a", "Acme");
    seedMembership({ id: "m1", accountId: "acct_a", userId: USER });
    seedSession("sess_1", USER);
    signIn("sess_1");

    const res = await run();

    expect(res.status).toBe(302);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    // Without the marker the callback's default branch upserts onto the existing
    // account instead of creating a second one.
    expect(parseConnectState(state)?.action).toBe(ADD_ACCOUNT_ACTION);
    // The callback compares state and cookie by string equality.
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(encodeURIComponent(state));
    expect(cookie).toContain("HttpOnly");
  });

  it("sends an anonymous caller to /login", async () => {
    harness.session = null;
    expect((await run()).headers.get("location")).toBe("/login");
  });
});
