import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J28, rows A7, A8 and A10: the three arrival flows against Recova.
//
// A7: Recova's invite page always offers "Accept invite". A signed-out click
// keeps the token in a short cookie and sends the visitor to sign up; once they
// are signed in the invite is accepted without a second click
// (app/api/invite/accept/route.ts blob 13708537, app/auth/callback/route.ts
// blob 7cb52c7b). A signed-in click under another address is refused with
// Recova's words.
// A8: /welcome needs the new connection's id, as Recova's does
// (app/welcome/page.tsx blob f0181a74), and goes to /console without it.
// A10: a disposable address refused at sign-up comes back to /login with
// Recova's own sentence, never Better Auth's bare error page.

const harness = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

const invite = await import("~/routes/auth/invite");
const welcome = await import("~/routes/app/welcome");
const login = await import("~/routes/auth/login");
const { authOptions } = await import("~/lib/auth/options");

const TOKEN = "tok_invite_1";
let sqlite: Database.Database;

beforeEach(() => {
  let db;
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.session = null;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_1', 'Acme', 1000)").run();
  sqlite
    .prepare(
      "INSERT INTO account_members (id, account_id, user_id, role, status, invited_email, invite_token, invite_expires_at, created_at) VALUES ('m_1', 'acc_1', NULL, 'member', 'pending', 'mate@acme.test', ?, ?, 1000)",
    )
    .run(TOKEN, Date.now() + 3_600_000);
});

function signIn(userId: string, email: string): void {
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(userId, userId, email);
  sqlite
    .prepare(
      "INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('sess_1', 9999999999999, 'tok_s', 0, ?)",
    )
    .run(userId);
  harness.session = { user: { id: userId, email }, session: { id: "sess_1" } };
}

const context = (auth?: unknown) =>
  ({
    get(key: unknown) {
      if (key === cloudflareContext) return { env: { BETTER_AUTH_URL: "https://foxhoundapp.test" }, ctx: {}, nonce: "n" };
      if (key === authContext && auth) return auth;
      throw new Error("unexpected context key");
    },
  }) as never;

async function run(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return (await fn()) as Response;
  } catch (thrown) {
    return thrown as Response;
  }
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://foxhoundapp.test${path}`, init);
}

describe("A7: accepting an invite before signing in", () => {
  it("keeps the invite through sign-up and accepts it on return, with no second click", async () => {
    const clicked = await run(() =>
      invite.action({ request: request(`/invite/${TOKEN}`, { method: "POST" }), params: { token: TOKEN }, context: context() } as never),
    );
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe(`/signup?next=${encodeURIComponent(`/invite/${TOKEN}`)}`);
    const cookie = clicked.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`invite_token=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);

    // Signed in as the invited address, back on the invite page with the cookie.
    signIn("user_mate", "mate@acme.test");
    const back = await run(() =>
      invite.loader({
        request: request(`/invite/${TOKEN}`, { headers: { cookie: `invite_token=${TOKEN}` } }),
        params: { token: TOKEN },
        context: context(),
      } as never),
    );
    expect(back.headers.get("location")).toBe("/console");
    expect(back.headers.get("set-cookie")).toMatch(/invite_token=;.*Max-Age=0/i);
    expect(sqlite.prepare("SELECT user_id AS u, status AS s FROM account_members WHERE id = 'm_1'").get()).toEqual({
      u: "user_mate",
      s: "active",
    });
    expect(sqlite.prepare("SELECT active_account_id AS a FROM session WHERE id = 'sess_1'").get()).toEqual({ a: "acc_1" });
  });

  it("refuses a signed-in click under another address with Recova's words", async () => {
    signIn("user_other", "other@globex.test");
    const res = (await invite.action({
      request: request(`/invite/${TOKEN}`, { method: "POST" }),
      params: { token: TOKEN },
      context: context(),
    } as never)) as unknown as { data: { error: string }; init: { status: number } };
    expect(res.init.status).toBe(403);
    expect(res.data.error).toBe(
      "This invite was sent to mate@acme.test. Copy this page's URL and open it in an incognito window to accept with the correct account.",
    );
    expect(sqlite.prepare("SELECT status AS s FROM account_members WHERE id = 'm_1'").get()).toEqual({ s: "pending" });
  });
});

describe("A8: /welcome is the landing for one new connection", () => {
  const auth = { membership: { accountId: "acc_1", accountName: "Acme" } };

  it("sends a visit without the connection, or with another account's, to /console", async () => {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acc_2', 'Globex', 1000)").run();
    sqlite
      .prepare("INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, created_at) VALUES ('conn_2', 'acc_2', 'acct_x', 1, 1000)")
      .run();
    for (const path of ["/welcome", "/welcome?connection=conn_2"]) {
      const res = await run(() => welcome.loader({ request: request(path), params: {}, context: context(auth) } as never));
      expect(res.headers.get("location")).toBe("/console");
    }
  });

  it("names the connection and says which of the two steps are done", async () => {
    sqlite
      .prepare("INSERT INTO stripe_connections (id, account_id, stripe_user_id, name, sender_name, is_primary, created_at) VALUES ('conn_1', 'acc_1', 'acct_y', NULL, 'Acme Support', 1, 1000)")
      .run();
    const data = await welcome.loader({ request: request("/welcome?connection=conn_1"), params: {}, context: context(auth) } as never);
    expect(data).toEqual({ connectionLabel: "acct_y", senderNameSet: true, notificationEmailSet: false });
  });
});

describe("A10: a disposable address at sign-up", () => {
  it("is refused with a code that brings the visitor back to /login with Recova's sentence", async () => {
    const before = authOptions.databaseHooks.user.create.before;
    await expect(before({ email: "x@mailinator.com" } as never)).rejects.toMatchObject({
      body: { code: "disposable_email" },
    });
    const page = await login.loader({ request: request("/login?error=disposable_email"), params: {}, context: context() } as never);
    expect((page as { error: string }).error).toBe(
      "Please use a real email address. Disposable email providers are not allowed.",
    );
  });
});
