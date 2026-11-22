import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A key's scope comes from the session, never the form; a revoke is pinned to
// the account; only the hash is stored; and the secret is shown once.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/app/settings/api-keys");
const { action, loader } = route;
const { verifyMcpToken, MCP_TOKEN_SCOPE, MCP_TOKEN_PREFIX } = await import("~/lib/auth/mcp-tokens");
const { API_KEY_LABEL_MAX_LENGTH } = await import("~/lib/settings/api-key-label");

const ACCOUNT = "acct_1";
const OTHER = "acct_other";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)")
    .run(ACCOUNT, "Acme");
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)")
    .run(OTHER, "Other");
});

function keyRows(accountId: string | null) {
  const sql =
    accountId === null
      ? "SELECT id, label, scope, revoked_at AS revokedAt FROM api_keys WHERE account_id IS NULL ORDER BY id"
      : "SELECT id, label, scope, revoked_at AS revokedAt FROM api_keys WHERE account_id = ? ORDER BY id";
  const stmt = sqlite.prepare(sql);
  return (accountId === null ? stmt.all() : stmt.all(accountId)) as {
    id: string;
    label: string | null;
    scope: string;
    revokedAt: number | null;
  }[];
}

function ctxFor(isAdmin: boolean, role = "owner") {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role },
          // Two memberships with the ACTIVE one second, so a reader that took
          // the earliest membership fails instead of coincidentally agreeing.
          memberships: [
            { memberId: "m1", accountId: OTHER, accountName: "Other", role: "owner" },
            { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role },
          ],
          activeAccountId: ACCOUNT,
          isAdmin,
          isDemo: false,
          demoSignedIn: false,
        };
      }
      throw new Error("unexpected context key");
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function post(
  fields: Record<string, string>,
  isAdmin = false,
  role = "owner",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctxFor(isAdmin, role),
    request: new Request("https://foxhoundapp.test/settings/api-keys", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("creating a key stores a hash and returns the secret once", () => {
  it("stores the key on the ACTIVE account and returns a working token", async () => {
    const res = await post({ _action: "create", label: "My agent" });

    expect(res.status).toBe(200);
    const raw = String(res.body.rawKey);
    expect(raw.startsWith(MCP_TOKEN_PREFIX)).toBe(true);

    const rows = keyRows(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("My agent");
    expect(rows[0].scope).toBe(MCP_TOKEN_SCOPE.MERCHANT);

    // The plaintext is never stored: only its hash, which is what verify uses.
    const stored = sqlite
      .prepare("SELECT key_hash AS h FROM api_keys WHERE id = ?")
      .get(rows[0].id) as {
      h: string;
    };
    expect(stored.h).not.toContain(raw);
    const verified = await verifyMcpToken(db, raw);
    expect(verified?.accountId).toBe(ACCOUNT);
  });

  it("the secret appears once in the page, in the reveal panel and nowhere else", () => {
    const SECRET = "fox_mcp_sample_secret_0123456789";
    const Page = route.default as unknown as (props: {
      loaderData: Record<string, unknown>;
      actionData: Record<string, unknown>;
    }) => ReactElement;
    const loaderData = { keys: [], loadError: false, callLog: { state: "owner-only" } };
    const actionData = { action: "create", ok: true, rawKey: SECRET };
    const Stub = createRoutesStub([
      {
        path: "/settings/api-keys",
        Component: () => createElement(Page, { loaderData, actionData }),
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(Stub, { initialEntries: ["/settings/api-keys"] }),
    );
    expect(html.split(SECRET).length - 1).toBe(1);
  });
});

describe("the scope is the session's, not the form's", () => {
  it("anyone posting scope=admin, admin or not, gets a merchant key", async () => {
    // An admin key would carry account_id NULL and reach every merchant. Admin
    // API keys are made only on /admin/operations.
    for (const isAdmin of [false, true]) {
      const res = await post({ _action: "create", label: `k-${isAdmin}`, scope: "admin" }, isAdmin);
      expect(res.status).toBe(200);
      const verified = await verifyMcpToken(db, String(res.body.rawKey));
      expect(verified?.scope).toBe(MCP_TOKEN_SCOPE.MERCHANT);
      expect(verified?.accountId).toBe(ACCOUNT);
    }
    expect(keyRows(null)).toHaveLength(0);
    expect(keyRows(ACCOUNT).map((r) => r.scope)).toEqual([
      MCP_TOKEN_SCOPE.MERCHANT,
      MCP_TOKEN_SCOPE.MERCHANT,
    ]);
  });
});

describe("revoke is pinned to the account, and only the owner manages keys", () => {
  it("revokes this account's key and verification stops accepting it", async () => {
    const created = await post({ _action: "create", label: "My agent" });
    const raw = String(created.body.rawKey);
    const id = keyRows(ACCOUNT)[0].id;

    const res = await post({ _action: "revoke", keyId: id });

    expect(res.status).toBe(200);
    expect(await verifyMcpToken(db, raw)).toBeNull();
  });

  it("403 and no revoke for a key on another account", async () => {
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES ('k_theirs', ?, 'h', 'Theirs', ?, 1000)",
      )
      .run(OTHER, MCP_TOKEN_SCOPE.MERCHANT);

    const res = await post({ _action: "revoke", keyId: "k_theirs" });

    expect(res.status).toBe(403);
    expect(keyRows(OTHER)[0].revokedAt).toBeNull();
  });

  it("403 and no key made or revoked for a member who is not the owner", async () => {
    const denied = await post({ _action: "create", label: "My agent" }, false, "member");
    expect(denied.status).toBe(403);
    expect(denied.body.rawKey).toBeUndefined();
    expect(keyRows(ACCOUNT)).toHaveLength(0);

    await post({ _action: "create", label: "My agent" });
    const id = keyRows(ACCOUNT)[0].id;
    expect((await post({ _action: "revoke", keyId: id }, false, "member")).status).toBe(403);
    expect(keyRows(ACCOUNT)[0].revokedAt).toBeNull();
  });
});

describe("the label is required and bounded", () => {
  it("400 and no write for an empty label or one over the bound; 200 exactly at it", async () => {
    expect((await post({ _action: "create", label: "   " })).status).toBe(400);
    const over = await post({ _action: "create", label: "x".repeat(API_KEY_LABEL_MAX_LENGTH + 1) });
    expect(over.status).toBe(400);
    expect(keyRows(ACCOUNT)).toHaveLength(0);

    const at = await post({ _action: "create", label: "y".repeat(API_KEY_LABEL_MAX_LENGTH) });
    expect(at.status).toBe(200);
    expect(keyRows(ACCOUNT)).toHaveLength(1);
  });
});

describe("the loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const read = async (role: string) =>
    (await loader({
      context: ctxFor(false, role),
      request: new Request("https://foxhoundapp.test/settings/api-keys"),
      params: {},
    } as never)) as {
      keys: unknown;
      loadError: boolean;
      callLog: { state: string; calls?: { id: string; error: string | null }[] };
    };

  it("lists the ACTIVE account's calls newest first and none of another account's; a member sees no log", async () => {
    const call = sqlite.prepare(
      "INSERT INTO mcp_calls (id, account_id, api_key_id, tool, outcome, error, created_at) VALUES (?, ?, 'k', ?, ?, ?, ?)",
    );
    call.run("c1", ACCOUNT, "get_overview", "ok", null, 2000);
    call.run(
      "c2",
      ACCOUNT,
      "update_settings",
      "tool_error",
      "Refused for someone@example.com",
      3000,
    );
    call.run("c3", OTHER, "get_overview", "ok", null, 4000);
    const owner = await read("owner");
    expect(owner.callLog.state).toBe("ok");
    expect(owner.callLog.calls!.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(owner.callLog.calls![0]!.error).not.toContain("someone@example.com");
    expect((await read("member")).callLog.state).toBe("owner-only");
  });

  it("returns a load-failure state instead of throwing when the read fails", async () => {
    harness.db = new Proxy(
      {},
      {
        get() {
          throw new Error("D1 unavailable");
        },
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await read("owner");
    expect(loaded.keys).toBeNull();
    expect(loaded.loadError).toBe(true);
  });
});
