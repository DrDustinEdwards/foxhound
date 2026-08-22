import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// S29, /settings/api-keys.
//
// The backend came first here: issueMcpToken / verifyMcpToken / revokeMcpToken
// have existed since Phase 3, whose header says the endpoints that call them
// "are Phase 7 and are NOT built here". This is the merchant-facing half.
//
// The plants are aimed at legacy's two client-only guards, which are the reason
// this row could not be ported verbatim: its scope picker is rendered behind
// isAdmin but READ from the request body, and its revoke takes an id with no
// account scope.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { action, loader } = await import("~/routes/app/settings/api-keys");
const { verifyMcpToken, MCP_TOKEN_SCOPE, MCP_TOKEN_PREFIX } = await import("~/lib/auth/mcp-tokens");
const { API_KEY_LABEL_MAX_LENGTH } = await import("~/lib/settings/api-key-label");

const ACCOUNT = "acct_1";
const OTHER = "acct_other";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(ACCOUNT, "Acme");
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, 1000)").run(OTHER, "Other");
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

function ctxFor(isAdmin: boolean) {
  return {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" };
      if (key === authContext) {
        return {
          userId: "user_1",
          userName: "Owner",
          email: "owner@acme.test",
          membership: { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
          // Two memberships with the ACTIVE one second, so a reader that took
          // the earliest membership fails instead of coincidentally agreeing.
          memberships: [
            { memberId: "m1", accountId: OTHER, accountName: "Other", role: "owner" },
            { memberId: "m2", accountId: ACCOUNT, accountName: "Acme", role: "owner" },
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = (await action({
    context: ctxFor(isAdmin),
    request: new Request("https://foxhoundapp.test/settings/api-keys", { method: "POST", body: form }),
    params: {},
  } as never)) as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: res.init?.status ?? 200, body: res.data };
}

describe("PLANT 1: creating a key stores a hash and returns the secret once", () => {
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
    const stored = sqlite.prepare("SELECT key_hash AS h FROM api_keys WHERE id = ?").get(rows[0].id) as {
      h: string;
    };
    expect(stored.h).not.toContain(raw);
    const verified = await verifyMcpToken(db, raw);
    expect(verified?.accountId).toBe(ACCOUNT);
  });

  it("a form posting extra column names writes none of them", async () => {
    await post({
      _action: "create",
      label: "My agent",
      accountId: OTHER,
      account_id: OTHER,
      keyHash: "pwned",
      key_hash: "pwned",
      revokedAt: "0",
      revoked_at: "0",
    });

    expect(keyRows(OTHER)).toHaveLength(0);
    const rows = keyRows(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
    const stored = sqlite.prepare("SELECT key_hash AS h FROM api_keys WHERE id = ?").get(rows[0].id) as {
      h: string;
    };
    expect(stored.h).not.toBe("pwned");
  });
});

describe("PLANT 2: the scope is the session's, not the form's", () => {
  it("A NON-ADMIN POSTING scope=admin GETS A MERCHANT KEY", async () => {
    // Legacy renders the picker behind isAdmin but reads body.scope in the
    // handler, so this exact request returns a platform-wide key there.
    const res = await post({ _action: "create", label: "sneaky", scope: "admin" }, false);

    expect(res.status).toBe(200);
    const rows = keyRows(ACCOUNT);
    expect(rows[0].scope).toBe(MCP_TOKEN_SCOPE.MERCHANT);
    // An admin key would carry account_id NULL and reach every merchant.
    expect(keyRows(null)).toHaveLength(0);

    const verified = await verifyMcpToken(db, String(res.body.rawKey));
    expect(verified?.scope).toBe(MCP_TOKEN_SCOPE.MERCHANT);
    expect(verified?.accountId).toBe(ACCOUNT);
  });

  it("an admin posting scope=admin does get an admin key", async () => {
    await post({ _action: "create", label: "ops", scope: "admin" }, true);
    expect(keyRows(null)).toHaveLength(1);
    expect(keyRows(null)[0].scope).toBe(MCP_TOKEN_SCOPE.ADMIN);
  });

  it("the scope picker only renders for an admin", async () => {
    const asMerchant = (await loader({
      context: ctxFor(false),
      request: new Request("https://x/settings/api-keys"),
      params: {},
    } as never)) as { isAdmin: boolean };
    expect(asMerchant.isAdmin).toBe(false);
  });
});

describe("PLANT 3: revoke is pinned to the account", () => {
  it("revokes this account's key and verification stops accepting it", async () => {
    const created = await post({ _action: "create", label: "My agent" });
    const raw = String(created.body.rawKey);
    const id = keyRows(ACCOUNT)[0].id;

    const res = await post({ _action: "revoke", keyId: id });

    expect(res.status).toBe(200);
    expect(await verifyMcpToken(db, raw)).toBeNull();
  });

  it("403 and NO revoke for a key on ANOTHER account", async () => {
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES ('k_theirs', ?, 'h', 'Theirs', ?, 1000)",
      )
      .run(OTHER, MCP_TOKEN_SCOPE.MERCHANT);

    const res = await post({ _action: "revoke", keyId: "k_theirs" });

    expect(res.status).toBe(403);
    expect(keyRows(OTHER)[0].revokedAt).toBeNull();
  });

  it("400 and NO revoke when no key id is sent", async () => {
    await post({ _action: "create", label: "My agent" });
    const res = await post({ _action: "revoke" });
    expect(res.status).toBe(400);
    expect(keyRows(ACCOUNT)[0].revokedAt).toBeNull();
  });
});

describe("PLANT 4: the label is required and bounded", () => {
  it("400 and NO write for an empty label", async () => {
    const res = await post({ _action: "create", label: "   " });
    expect(res.status).toBe(400);
    expect(keyRows(ACCOUNT)).toHaveLength(0);
  });

  it("400 one over the bound, 200 exactly at it", async () => {
    const over = await post({ _action: "create", label: "x".repeat(API_KEY_LABEL_MAX_LENGTH + 1) });
    expect(over.status).toBe(400);
    expect(keyRows(ACCOUNT)).toHaveLength(0);

    const at = await post({ _action: "create", label: "y".repeat(API_KEY_LABEL_MAX_LENGTH) });
    expect(at.status).toBe(200);
    expect(keyRows(ACCOUNT)).toHaveLength(1);
  });

  it("no error string carries a wide dash", async () => {
    const wide = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
    const res = await post({ _action: "create", label: "" });
    expect(String(res.body.error)).not.toMatch(wide);
  });
});

describe("PLANT 5: the list is live, merchant-scoped and this account's", () => {
  it("excludes revoked keys, admin keys, and other accounts", async () => {
    const live = await post({ _action: "create", label: "live" });
    expect(live.status).toBe(200);
    await post({ _action: "create", label: "gone" });
    const gone = keyRows(ACCOUNT).find((k) => k.label === "gone")!;
    await post({ _action: "revoke", keyId: gone.id });
    await post({ _action: "create", label: "platform", scope: "admin" }, true);
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES ('k_theirs', ?, 'h', 'Theirs', ?, 1000)",
      )
      .run(OTHER, MCP_TOKEN_SCOPE.MERCHANT);
    // An admin-scoped row that DOES carry this account id. issueMcpToken never
    // makes one, so the account filter alone would not exclude it; the scope
    // filter is what does, and without this row that filter is untestable.
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, account_id, key_hash, label, scope, created_at) VALUES ('k_admin_scoped', ?, 'h2', 'Wrong scope', ?, 1000)",
      )
      .run(ACCOUNT, MCP_TOKEN_SCOPE.ADMIN);

    const loaded = (await loader({
      context: ctxFor(true),
      request: new Request("https://x/settings/api-keys"),
      params: {},
    } as never)) as { keys: { label: string | null }[] };

    expect(loaded.keys.map((k) => k.label)).toEqual(["live"]);
  });
});

describe("PLANT 6: the render carries legacy's control set", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../app/routes/app/settings/api-keys.tsx", import.meta.url)),
    "utf8",
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has the table, the generate panel, the one-time reveal and both empty states", () => {
    expect(code).toContain("Generate new key");
    expect(code).toContain("Revoke key");
    expect(code).toContain("Last used");
    expect(code).toContain("This key will not be shown again.");
    expect(code).toContain("No API keys yet. Generate one to get started.");
  });

  it("never uses a browser alert, which is what legacy does on failure", () => {
    expect(code).not.toContain("alert(");
  });

  it("every write goes through DemoGuardedForm", () => {
    expect(code).toContain('<DemoGuardedForm method="post"');
    expect(code).not.toContain('<Form method="post"');
    expect(code).not.toContain('<form method="post"');
  });

  it("the length bound is imported from the client-safe module", () => {
    expect(SOURCE).toContain('API_KEY_LABEL_MAX_LENGTH } from "~/lib/settings/api-key-label"');
    expect(SOURCE).not.toMatch(/API_KEY_LABEL_MAX_LENGTH[^;]*from "[^"]*\.server"/);
  });
});

describe("PLANT 7: the docs describe the key lifecycle honestly", () => {
  const DOCS = readFileSync(
    fileURLToPath(new URL("../app/lib/marketing/docs-content.ts", import.meta.url)),
    "utf8",
  );

  it("says the key is shown once and that only its hash is stored", () => {
    expect(DOCS).toContain("Settings and API keys");
    expect(DOCS).toContain("shown once");
    expect(DOCS).toContain("only its hash is stored");
    expect(DOCS).toContain("A revoked key stops working immediately.");
  });
});
