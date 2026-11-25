import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The theme write must land on the session's active account, not the earliest membership. Two
// accounts per fixture, the active one second by createdAt, so the shim's ordering cannot pass by accident.

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

const { action: themeAction } = await import("~/routes/api/theme");

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
  seedAccount(EARLIEST, "Earliest Ltd", 1_000, "dark");
  seedAccount(MARKED, "Marked Ltd", 2_000, "light");
  seedMembership("m_1", EARLIEST, 1_000);
  seedMembership("m_2", MARKED, 2_000);
  seedSession(MARKED);
  harness.session = {
    user: { id: USER, name: USER, email: "owner@acme.test" },
    session: { id: SESSION_ID, activeAccountId: MARKED },
  };
});

function seedAccount(id: string, name: string, createdAt: number, theme: string | null): void {
  sqlite
    .prepare("INSERT INTO accounts (id, name, theme, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, theme, createdAt);
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

function themeOf(accountId: string): string | null {
  const row = sqlite.prepare("SELECT theme AS t FROM accounts WHERE id = ?").get(accountId) as
    | { t: string | null }
    | undefined;
  return row?.t ?? null;
}

const fakeContext = {
  get(key: unknown) {
    if (key === cloudflareContext) {
      return { env: {} as Env, ctx: {} as ExecutionContext };
    }
    throw new Error("unexpected context key");
  },
} as unknown as Parameters<typeof themeAction>[0]["context"];

/** A request carrying the session cookie marker resolveThemeForRequest greps for. */
function signedInRequest(init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", "better-auth.session_token=tok_1");
  return new Request("https://foxhoundapp.test/connect", { ...init, headers });
}

describe("the theme write targets the active account", () => {
  it("writes the MARKED account row and leaves the earliest one alone", async () => {
    const response = (await themeAction({
      request: signedInRequest({
        method: "POST",
        body: JSON.stringify({ theme: "dark" }),
        headers: { "content-type": "application/json" },
      }),
      context: fakeContext,
      params: {},
    } as unknown as Parameters<typeof themeAction>[0])) as Response;

    expect(response.status).toBe(204);
    expect(themeOf(MARKED)).toBe("dark");
    expect(themeOf(EARLIEST)).toBe("dark");
  });
});
