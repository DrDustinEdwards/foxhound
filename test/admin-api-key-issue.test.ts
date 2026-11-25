import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Admin API keys are issued and revoked on /admin/operations; a no-op revoke records nothing.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action } = await import("~/routes/admin/operations");
const { verifyMcpToken, MCP_TOKEN_SCOPE } = await import("~/lib/auth/mcp-tokens");

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
});

async function post(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext };
      if (key === adminContext) return { email: "admin@example.com" };
      throw new Error("unexpected context key");
    },
  };
  const res = (await action({
    request: new Request("https://example.com/admin/operations", { method: "POST", body }),
    context,
    params: {},
  } as never)) as unknown as { init: { status?: number } | null; data: Record<string, unknown> };
  return { status: res.init?.status ?? 200, body: res.data };
}

const audit = () =>
  sqlite
    .prepare("SELECT action, actor_email AS actor, metadata FROM admin_audit_log ORDER BY rowid")
    .all() as { action: string; actor: string; metadata: string }[];

describe("Admin API keys in the admin area", () => {
  it("issues a platform key, shown once, with its audit row", async () => {
    const res = await post({ intent: "issue-admin-key", label: "foxhound-admin-mcp" });

    expect(res.status).toBe(200);
    const verified = await verifyMcpToken(harness.db as never, String(res.body.rawKey));
    expect(verified).toMatchObject({ scope: MCP_TOKEN_SCOPE.ADMIN, accountId: null });
    expect(audit()).toEqual([
      expect.objectContaining({ action: "admin_api_key.issue", actor: "admin@example.com" }),
    ]);
  });

  it("revokes a live admin key once, and a second revoke records nothing", async () => {
    await post({ intent: "issue-admin-key", label: "old" });
    const { id } = sqlite.prepare("SELECT id FROM api_keys").get() as { id: string };

    expect((await post({ intent: "revoke-admin-key", keyId: id })).status).toBe(200);
    expect((await post({ intent: "revoke-admin-key", keyId: id })).status).toBe(400);

    const rows = audit();
    expect(rows.map((r) => r.action)).toEqual(["admin_api_key.issue", "admin_api_key.revoke"]);
    expect(JSON.parse(rows[1].metadata)).toEqual({ keyId: id, label: "old" });
  });

  it("will not revoke a merchant's key", async () => {
    sqlite.exec(
      "INSERT INTO accounts (id, name, created_at) VALUES ('acct_1', 'Acme', 1000);" +
        "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES ('k_m', 'acct_1', 'h', 'Theirs', 'mcp_merchant', 1000);",
    );

    expect((await post({ intent: "revoke-admin-key", keyId: "k_m" })).status).toBe(400);
    expect(sqlite.prepare("SELECT revoked_at AS r FROM api_keys").get()).toEqual({ r: null });
    expect(audit()).toEqual([]);
  });
});
