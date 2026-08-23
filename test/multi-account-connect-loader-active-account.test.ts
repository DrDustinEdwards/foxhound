import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 61, phase (c): the /connect LOADER half of the query re-audit's
// non-money DEFECTS. The theme pair is in
// multi-account-theme-active-account.test.ts.
//
// EACH ONE IS A SHIM CALLER. `resolveMembership` is the null-marker shim, which
// resolves the EARLIEST membership and ignores the session marker. That was
// invisible until phase (e) shipped a switcher, because the earliest and the
// active membership could not differ. They can now, so every one of these reads
// or writes the wrong account for a merchant who has switched.
//
// TWO ACCOUNTS IN EVERY FIXTURE (352 binding 4): an account-scope pin is
// unprovable with one, because every wrong answer is also the right one.
//
// The marked account is deliberately the SECOND by createdAt, so no plant here
// can pass by accident on the shim's own ordering.

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

const { loader: connectLoader } = await import("~/routes/auth/connect");

const USER = "user_1";
const EARLIEST = "acct_earliest";
const MARKED = "acct_marked";
const SESSION_ID = "sess_1";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)",
    )
    .run(USER, USER, "owner@acme.test");
  seedAccount(EARLIEST, "Earliest Ltd", 1_000);
  seedAccount(MARKED, "Marked Ltd", 2_000);
  seedMembership("m_1", EARLIEST, 1_000);
  seedMembership("m_2", MARKED, 2_000);
  seedSession(MARKED);
  harness.session = {
    user: { id: USER, name: USER, email: "owner@acme.test" },
    session: { id: SESSION_ID, activeAccountId: MARKED },
  };
});

function seedAccount(id: string, name: string, createdAt: number): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, createdAt);
}

function seedMembership(id: string, accountId: string, createdAt: number): void {
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    )
    .run(id, accountId, USER, createdAt);
}

function seedSession(activeAccountId: string | null): void {
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(SESSION_ID, 9_999_999_999_999, "tok_1", USER, activeAccountId);
}


const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof connectLoader>[0]["context"];

/** A request carrying the session cookie marker resolveThemeForRequest greps for. */
function signedInRequest(init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", "better-auth.session_token=tok_1");
  return new Request("https://foxhoundapp.test/connect", { ...init, headers });
}

describe("DEFECT 3: /connect's loader described the earliest account, not the active one", () => {
  it("reports the MARKED account name on the page that grants Stripe access", async () => {
    // The action this loader renders starts an OAuth flow whose callback
    // attaches to the ACTIVE account (connect-callback.ts:223, phase (d)). The
    // loader named a different one, so the screen where a merchant grants a
    // live payment processor told them the wrong merchant it was for.
    const result = (await connectLoader({
      request: signedInRequest(),
      context: fakeContext,
      params: {},
    } as unknown as Parameters<typeof connectLoader>[0])) as {
      accountName: string | null;
      hasConnection: boolean;
    };

    expect(result.accountName).toBe("Marked Ltd");
  });

  it("reports the MARKED account connection state, not the earliest one", async () => {
    // hasConnection is read per account. The earliest holds a live connection
    // and the marked one holds none, so the shim showed "already connected" for
    // an account with nothing attached.
    sqlite
      .prepare(
        "INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, connected_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("conn_1", EARLIEST, "acct_stripe_earliest", "enc", 1_000, 1_000);

    const result = (await connectLoader({
      request: signedInRequest(),
      context: fakeContext,
      params: {},
    } as unknown as Parameters<typeof connectLoader>[0])) as {
      accountName: string | null;
      hasConnection: boolean;
    };

    expect(result.hasConnection).toBe(false);
  });
});
