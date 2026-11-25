import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  deauthorizeCalls: [] as string[],
  deleteCalls: 0,
  deleteThrows: false,
  signedInAt: new Date(),
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/connect", () => ({
  deauthorizeConnectedAccount: async (_env: unknown, stripeUserId: string) => {
    harness.deauthorizeCalls.push(stripeUserId);
    return { ok: true };
  },
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));

vi.mock("~/lib/auth/auth.server", () => ({
  getBetterAuth: () => ({
    api: {
      getSession: async () => ({
        session: { createdAt: harness.signedInAt },
        user: { id: "user_1" },
      }),
      // Better Auth's /delete-user, whose hooks are the deletion; it takes no
      // id, so the session's user is the one deleted.
      deleteUser: async () => {
        harness.deleteCalls += 1;
        if (harness.deleteThrows) throw new Error("D1 batch failed");
        return new Response(JSON.stringify({ success: true }), {
          headers: { "set-cookie": "better-auth.session_token=; Max-Age=0; Path=/" },
        });
      },
    },
  }),
}));

const route = await import("~/routes/app/settings/account");
const { MRR_ERROR } = await import("~/lib/settings/apply.server");

const ACTIVE = "acct_1";
const EARLIEST = "acct_earliest";

type Result = { data: Record<string, unknown>; init?: { status?: number } };

/** The caller holds two accounts and is switched to the later one, so a reader
 *  that took the earliest membership fails instead of coincidentally agreeing. */
function ctx(role: "owner" | "member" = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m2", accountId: ACTIVE, accountName: "Acme Inc", role },
          memberships: [
            { memberId: "m1", accountId: EARLIEST, accountName: "Earliest Co", role: "owner" },
            { memberId: "m2", accountId: ACTIVE, accountName: "Acme Inc", role },
          ],
          activeAccountId: ACTIVE,
          isAdmin: false,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as never;
}

/** The action's answer: a redirect Response or, for react-router's data(), its
 *  data and init. A redirect thrown instead of returned is caught as well. */
async function post(
  fields: Record<string, string>,
  role: "owner" | "member" = "owner",
): Promise<Result & Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  try {
    return (await route.action({
      context: ctx(role),
      request: new Request("https://foxhoundapp.test/settings/account", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never)) as never;
  } catch (thrown) {
    return thrown as never;
  }
}

describe("account: the profile form", () => {
  const Page = route.default as unknown as (props: {
    loaderData: Record<string, unknown>;
  }) => ReactElement;

  it("keeps an industry stored outside the list, so a save does not erase it", () => {
    // The merchant's agent tool takes free text through the same apply layer.
    const loaderData = {
      account: {
        name: "Acme Inc",
        merchantIndustry: "Veterinary",
        primaryCustomerType: null,
        merchantMrrSelfReported: null,
      },
      cancelledAt: null,
      userEmail: "owner@acme.test",
      ownedAccountNames: ["Acme Inc"],
      theme: "dark",
      isOwner: true,
      isDemo: false,
      signIn: { passkeys: [], providers: [] },
    };
    const Stub = createRoutesStub([
      { path: "/settings/account", Component: () => createElement(Page, { loaderData }) },
    ]);
    const html = renderToStaticMarkup(
      createElement(Stub, { initialEntries: ["/settings/account"] }),
    );
    const select = html.match(/<select[^>]*name="merchantIndustry"[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).toMatch(/<option value="Veterinary" selected="">Veterinary<\/option>/);
  });

  describe("one save writes the name and the three context fields", () => {
    let sqlite: Database.Database;

    beforeEach(() => {
      const made = createInMemoryDb();
      sqlite = made.sqlite;
      harness.db = made.db;
      sqlite
        .prepare(
          "INSERT INTO accounts (id, name, merchant_industry, primary_customer_type, merchant_mrr_self_reported, created_at, billing_exempt) VALUES (?, ?, ?, ?, ?, 0, 0)",
        )
        .run(ACTIVE, "Old Name", "Finance", "B2C", 100);
      sqlite
        .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, 0, 0)")
        .run("acct_other", "Other Co");
    });

    const row = (id = ACTIVE) =>
      sqlite
        .prepare(
          "SELECT name, merchant_industry AS industry, primary_customer_type AS type, merchant_mrr_self_reported AS mrr FROM accounts WHERE id = ?",
        )
        .get(id) as {
        name: string;
        industry: string | null;
        type: string | null;
        mrr: number | null;
      };
    const UNCHANGED = { name: "Old Name", industry: "Finance", type: "B2C", mrr: 100 };

    it("writes all four from one post, MRR in cents, and touches no other account", async () => {
      const res = await post({
        _action: "profile",
        name: "Acme Inc",
        merchantIndustry: "SaaS",
        primaryCustomerType: "B2B",
        merchantMrrSelfReported: "5000",
      });
      expect(res.data).toEqual({ action: "profile", ok: true });
      expect(row()).toEqual({ name: "Acme Inc", industry: "SaaS", type: "B2B", mrr: 500_000 });
      expect(row("acct_other").name).toBe("Other Co");
    });

    it("refuses a bad MRR or an empty name beside its field and writes nothing at all", async () => {
      const badMrr = await post({
        _action: "profile",
        name: "New Name",
        merchantIndustry: "SaaS",
        primaryCustomerType: "B2B",
        merchantMrrSelfReported: "-5",
      });
      expect(badMrr.init?.status).toBe(400);
      expect(badMrr.data).toEqual({
        action: "profile",
        ok: false,
        error: MRR_ERROR,
        field: "merchantMrrSelfReported",
      });
      const noName = await post({
        _action: "profile",
        name: "  ",
        merchantIndustry: "SaaS",
        merchantMrrSelfReported: "1",
      });
      expect(noName.init?.status).toBe(400);
      expect(noName.data).toMatchObject({ action: "profile", ok: false, field: "name" });
      expect(row()).toEqual(UNCHANGED);
    });
  });
});

describe("account: cancel and delete", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    const made = createInMemoryDb();
    sqlite = made.sqlite;
    harness.db = made.db;
    harness.deauthorizeCalls = [];
    harness.deleteCalls = 0;
    harness.deleteThrows = false;
    harness.signedInAt = new Date();
    sqlite
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES ('user_1', 'Owner', 'owner@acme.test', 0, 0)",
      )
      .run();
    for (const [id, name, createdAt, memberId] of [
      [EARLIEST, "Earliest Co", 1_000, "m1"],
      [ACTIVE, "Acme Inc", 2_000, "m2"],
    ] as const) {
      sqlite
        .prepare("INSERT INTO accounts (id, name, created_at, billing_exempt) VALUES (?, ?, ?, 0)")
        .run(id, name, createdAt);
      sqlite
        .prepare(
          "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, 'user_1', 'owner', 'active', ?)",
        )
        .run(memberId, id, createdAt);
    }
    sqlite
      .prepare(
        "INSERT INTO session (id, expires_at, token, updated_at, user_id, active_account_id) VALUES ('sess_1', 9999999999999, 'tok', 0, 'user_1', ?)",
      )
      .run(ACTIVE);
    harness.session = {
      user: { id: "user_1", name: "Owner", email: "owner@acme.test" },
      session: { id: "sess_1", activeAccountId: ACTIVE },
    };
    for (const [id, stripeUserId, primary] of [
      ["c_a", "acct_a", 1],
      ["c_b", "acct_b", 0],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, connected_at, disconnected_at, created_at) VALUES (?, ?, ?, ?, 1000, NULL, 1000)",
        )
        .run(id, ACTIVE, stripeUserId, primary);
    }
  });

  const state = () => ({
    cancelledAt: (
      sqlite.prepare("SELECT cancelled_at AS c FROM accounts WHERE id = ?").get(ACTIVE) as {
        c: unknown;
      }
    ).c,
    disconnected: (
      sqlite.prepare("SELECT disconnected_at AS d FROM stripe_connections ORDER BY id").all() as {
        d: unknown;
      }[]
    ).map((r) => r.d !== null),
  });
  const marker = () =>
    (
      sqlite.prepare("SELECT active_account_id AS m FROM session WHERE id = 'sess_1'").get() as {
        m: string;
      }
    ).m;

  it("cancel stamps the account, disconnects every live connection and moves the session", async () => {
    const res = await post({ _action: "cancel-account" });
    expect(res.data).toMatchObject({ action: "cancel-account", ok: true });
    expect(state().cancelledAt).not.toBeNull();
    expect(state().disconnected).toEqual([true, true]);
    expect([...harness.deauthorizeCalls].sort()).toEqual(["acct_a", "acct_b"]);
    // The caller still holds the earliest account, so the session lands there.
    expect(marker()).toBe(EARLIEST);
  });

  it("only the owner can cancel: a member is refused with a 403 and nothing is written", async () => {
    const res = await post({ _action: "cancel-account" }, "member");
    expect(res.init?.status).toBe(403);
    expect(res.data).toEqual({
      action: "cancel-account",
      ok: false,
      error: "Only the account owner can cancel the account.",
    });
    expect(state()).toEqual({ cancelledAt: null, disconnected: [false, false] });
  });

  it("delete removes the signed-in user, signs them out and sends them home", async () => {
    const res = await post({ _action: "delete-account" });
    expect(harness.deleteCalls).toBe(1);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("better-auth.session_token=;");
  });

  it("delete refuses a sign-in older than 10 minutes and deletes nothing", async () => {
    harness.signedInAt = new Date(Date.now() - 11 * 60_000);
    const res = await post({ _action: "delete-account" });
    expect(harness.deleteCalls).toBe(0);
    expect(res.init?.status).toBe(403);
    expect(res.data).toEqual({ action: "delete-account", ok: false, error: "stale" });
  });

  it("a failed delete keeps the person signed in and says so", async () => {
    harness.deleteThrows = true;
    const res = await post({ _action: "delete-account" });
    expect(res.init?.status).toBe(500);
    expect(res.data).toEqual({
      action: "delete-account",
      ok: false,
      error: "Failed to delete account. Please contact support.",
    });
  });

  it("deletion is never an agent tool: no agent surface reaches it", () => {
    for (const path of [
      "app/lib/mcp/tools.server.ts",
      "app/lib/mcp/server.ts",
      "app/lib/mcp/handler.server.ts",
      "app/lib/admin-api/handler.server.ts",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
      expect(source, path).not.toContain("delete-account");
      expect(source, path).not.toContain("deleteUserAccount");
    }
  });
});
