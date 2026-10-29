import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Where the emailed sign-in link lands (/passkey?next=): an account with no
// live Stripe connection goes on to /connect, as Recova sent a new signup
// (app/(auth)/signup/page.tsx, blob 08400b4d), not to an empty console. Found
// in production on 2026-10-29, the first real signup.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth")>()),
  getAuth: async () => ({
    api: {
      getSession: async () => ({ user: { id: "user_1" }, session: { activeAccountId: null } }),
      listPasskeys: async () => [],
    },
  }),
}));

const { loader } = await import("~/routes/auth/passkey-offer");

let sqlite: Database.Database;

beforeEach(() => {
  let db: unknown;
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite.prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES ('user_1', '', 'owner@acme.test', 1, 0)").run();
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_1', 'Acme', 1000)").run();
  sqlite
    .prepare("INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES ('m_1', 'acct_1', 'user_1', 'owner', 'active', 1000)")
    .run();
});

async function landing(next: string): Promise<string> {
  const ctx = { get: () => ({ env: {} as Env, ctx: {} as ExecutionContext, nonce: "" }) };
  const result = (await loader({
    request: new Request(`https://foxhoundapp.test/passkey?next=${encodeURIComponent(next)}`),
    context: ctx,
    params: {},
  } as never)) as { next: string };
  return result.next;
}

describe("the emailed sign-in link's landing", () => {
  it("sends an account with no live Stripe connection to /connect, a connected one to /console, and keeps an explicit next", async () => {
    expect(await landing("/console")).toBe("/connect");
    expect(await landing("/invite/tok_1")).toBe("/invite/tok_1");

    sqlite
      .prepare("INSERT INTO stripe_connections (id, account_id, stripe_user_id, stripe_access_token, connected_at, created_at) VALUES ('c_1', 'acct_1', 'acct_stripe_1', 'enc', 1000, 1000)")
      .run();
    expect(await landing("/console")).toBe("/console");
  });
});
