import { describe, expect, it } from "vitest";
import { apiKeys, oauthGrants } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_CODE_TTL_MS } from "~/lib/constants";
import { removeMember } from "~/lib/auth/account";
import { deleteUserAccountLocal } from "~/lib/auth/delete-account.server";
import { DISALLOW_PATHS } from "~/lib/seo/files";
import { defineToolRegistry, type McpTool } from "~/lib/mcp/registry";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";
import {
  ACCOUNT_B,
  NOW,
  ORIGIN,
  authorizeRoute,
  consent,
  context,
  db,
  env,
  fullFlow,
  handleMcpRequest,
  harness,
  pkcePair,
  provider,
  registered,
  revokeRoute,
  sqlite,
  tokenCall,
  tokenRoute,
} from "./helpers/oauth-provider";

describe("the token endpoint", () => {
  it("issues a one-hour merchant key for the consenting account, which /mcp accepts", async () => {
    const { access, refresh } = await fullFlow();
    expect(access.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(refresh.startsWith("fox_rt_")).toBe(true);
    const verified = await verifyMcpToken(db, access);
    expect(verified).toMatchObject({ accountId: ACCOUNT_B, scope: MCP_TOKEN_SCOPE.MERCHANT });
    const [key] = await db.select().from(apiKeys);
    expect(key.expiresAt!.getTime() - key.createdAt.getTime()).toBe(
      OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    expect(key.label).toBe("Claude (OAuth)");

    const res = (await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          },
        }),
      }),
      env(),
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("answers the token response with no-store", async () => {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const back = await consent(clientId, challenge);
    const { status, body, res } = await tokenCall(
      {
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        code_verifier: verifier,
        client_id: clientId,
      },
      true,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "merchant.read" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });

  it("refuses a wrong verifier, a wrong client, a wrong redirect and an expired code", async () => {
    const clientId = await registered();
    const other = await registered();
    const bad = async (
      fields: (code: string, verifier: string) => Record<string, string>,
      label: string,
      at?: Date,
    ) => {
      const { verifier, challenge } = await pkcePair();
      const code = (await consent(clientId, challenge)).searchParams.get("code")!;
      const res = at
        ? await provider.exchangeToken(db, new URLSearchParams(fields(code, verifier)), at)
        : await tokenCall(fields(code, verifier));
      expect(res.status, label).toBe(400);
      expect(res.body.error, label).toBe("invalid_grant");
    };
    await bad(
      (code) => ({
        grant_type: "authorization_code",
        code,
        code_verifier: "x".repeat(43),
        client_id: clientId,
      }),
      "verifier",
    );
    await bad(
      (code, v) => ({ grant_type: "authorization_code", code, code_verifier: v, client_id: other }),
      "client",
    );
    await bad(
      (code, v) => ({
        grant_type: "authorization_code",
        code,
        code_verifier: v,
        client_id: clientId,
        redirect_uri: "https://claude.ai/other",
      }),
      "redirect",
    );
    await bad(
      (code, v) => ({
        grant_type: "authorization_code",
        code,
        code_verifier: v,
        client_id: clientId,
      }),
      "expired",
      new Date(Date.now() + OAUTH_CODE_TTL_MS + 1000),
    );
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it("a code used twice is refused and kills what the first use made", async () => {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const code = (await consent(clientId, challenge)).searchParams.get("code")!;
    const fields = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
    };
    const first = await tokenCall(fields);
    expect(first.status).toBe(200);
    const second = await tokenCall(fields);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");
    expect(await verifyMcpToken(db, first.body.access_token as string)).toBeNull();
    const [grant] = await db.select().from(oauthGrants);
    expect(grant.revokedAt).not.toBeNull();
  });

  it("refuses an unknown grant type and a body it cannot read", async () => {
    expect((await tokenCall({ grant_type: "password" })).body.error).toBe("unsupported_grant_type");
    const res = (await tokenRoute.action({
      request: new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "x",
      }),
      context: context(),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });
});

describe("refresh: rotation in place, replay kills the grant", () => {
  it("rotates both tokens on the same key row, so Settings shows one connection", async () => {
    const { clientId, access, refresh } = await fullFlow();
    const next = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(refresh);
    expect(await verifyMcpToken(db, access)).toBeNull();
    expect(await verifyMcpToken(db, next.body.access_token as string)).toMatchObject({
      accountId: ACCOUNT_B,
    });
    expect(await db.select().from(apiKeys)).toHaveLength(1);
  });

  it("presenting a replaced refresh token revokes the grant", async () => {
    const { clientId, refresh } = await fullFlow();
    const next = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    const replay = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await verifyMcpToken(db, next.body.access_token as string)).toBeNull();
    const again = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: next.body.refresh_token as string,
      client_id: clientId,
    });
    expect(again.body.error).toBe("invalid_grant");
  });

  it("a key revoked in Settings cannot be refreshed back to life", async () => {
    const { clientId, refresh } = await fullFlow();
    await db.update(apiKeys).set({ revokedAt: new Date() });
    const res = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("refuses another client's refresh token", async () => {
    const { refresh } = await fullFlow();
    const other = await registered();
    expect(
      (await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: other }))
        .body.error,
    ).toBe("invalid_grant");
  });
});

describe("expiry and revocation", () => {
  it("verifyMcpToken refuses an access token past its hour", async () => {
    const { access } = await fullFlow();
    await db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyMcpToken(db, access)).toBeNull();
  });

  it("revocation always answers 200 and kills the grant by either token", async () => {
    const revoke = async (token: string) =>
      (await revokeRoute.action({
        request: new Request(`${ORIGIN}/api/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        }),
        context: context(),
        params: {},
      } as never)) as Response;
    expect((await revoke("fox_rt_unknown")).status).toBe(200);
    const one = await fullFlow();
    expect((await revoke(one.refresh)).status).toBe(200);
    expect(await verifyMcpToken(db, one.access)).toBeNull();
    const two = await fullFlow();
    expect((await revoke(two.access)).status).toBe(200);
    expect(
      (
        await tokenCall({
          grant_type: "refresh_token",
          refresh_token: two.refresh,
          client_id: two.clientId,
        })
      ).body.error,
    ).toBe("invalid_grant");
  });
});

describe("the authorize page stays out of caches, analytics and crawls", () => {
  it("is private and crawl-disallowed", () => {
    expect(authorizeRoute.headers()).toBe(PRIVATE_PAGE_HEADERS);
    expect(DISALLOW_PATHS).toContain("/oauth/");
  });
});

// A grant is one person's delegation: it lasts only while that person is still
// an active member of the account.

async function makeMember(): Promise<void> {
  // USER owns ACCOUNT_B in the fixture; removeMember refuses an owner, so the
  // consenting person is made an ordinary member after consenting (only an
  // owner may consent; a grant a member made before that rule still exists).
  sqlite.prepare("UPDATE account_members SET role = 'member' WHERE id = ?").run(`m_${ACCOUNT_B}`);
}

describe("a grant ends when the person who approved it leaves the account", () => {
  it("removed between consent and exchange: the code is refused and mints nothing", async () => {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const code = (await consent(clientId, challenge)).searchParams.get("code")!;
    await makeMember();
    expect((await removeMember(db, ACCOUNT_B, `m_${ACCOUNT_B}`)).ok).toBe(true);
    const res = await tokenCall({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(await db.select().from(apiKeys)).toHaveLength(0);
    expect(await db.select().from(oauthGrants)).toHaveLength(0);
  });

  it("removeMember ends their grant and its key at once, and refresh cannot revive it", async () => {
    const { clientId, access, refresh } = await fullFlow();
    await makeMember();
    expect((await removeMember(db, ACCOUNT_B, `m_${ACCOUNT_B}`)).ok).toBe(true);
    expect(await verifyMcpToken(db, access)).toBeNull();
    const [grant] = await db.select().from(oauthGrants);
    expect(grant.revokedAt).not.toBeNull();
    const res = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("a closed account's access token stops working", async () => {
    const { access } = await fullFlow();
    expect(await verifyMcpToken(db, access)).not.toBeNull();
    sqlite
      .prepare("UPDATE accounts SET cancelled_at = ? WHERE id = ?")
      .run(NOW.getTime(), ACCOUNT_B);
    expect(await verifyMcpToken(db, access)).toBeNull();
  });

  it("a membership gone by any other path: the next refresh refuses and revokes", async () => {
    const { clientId, access, refresh } = await fullFlow();
    sqlite.prepare("DELETE FROM account_members WHERE id = ?").run(`m_${ACCOUNT_B}`);
    const res = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(await verifyMcpToken(db, access)).toBeNull();
    const [grant] = await db.select().from(oauthGrants);
    expect(grant.revokedAt).not.toBeNull();
  });

  it("deleting the person ends their grant on an account they do not own, under foreign keys", async () => {
    sqlite.pragma("foreign_keys = ON");
    sqlite
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, updated_at) VALUES ('user_2', 'Eli', 'eli@acme.test', 0, 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES ('m_eli', ?, 'user_2', 'owner', 'active', 3000)",
      )
      .run(ACCOUNT_B);
    harness.session = {
      user: { id: "user_2", name: "Eli", email: "eli@acme.test" },
      session: { id: "s2", activeAccountId: ACCOUNT_B },
    };
    const elis = await fullFlow();
    // Eli consented as an owner and is an ordinary member when deleted.
    sqlite.prepare("UPDATE account_members SET role = 'member' WHERE id = 'm_eli'").run();
    const result = await deleteUserAccountLocal(db, "user_2", new Date());
    expect(result.status).toBe("deleted");
    expect(await verifyMcpToken(db, elis.access)).toBeNull();
    expect(await db.select().from(oauthGrants)).toHaveLength(0);
    expect(
      (
        await tokenCall({
          grant_type: "refresh_token",
          refresh_token: elis.refresh,
          client_id: elis.clientId,
        })
      ).body.error,
    ).toBe("invalid_grant");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("least scope: read unless the owner allows changes", () => {
  const writes: string[] = [];
  const tool = (name: string, scope: "read" | "write"): McpTool => ({
    name,
    title: name,
    description: name,
    inputSchema: { type: "object", additionalProperties: false },
    annotations: {
      readOnlyHint: scope === "read",
      destructiveHint: scope === "write",
      idempotentHint: true,
      openWorldHint: false,
    },
    scope,
    execute: async () => {
      if (scope === "write") writes.push(name);
      return { ok: true };
    },
  });
  const REGISTRY = defineToolRegistry([
    tool("foxhound_get_probe", "read"),
    tool("foxhound_update_probe", "write"),
  ]);

  async function grant(allowWrite: boolean): Promise<{ access: string; scope: unknown }> {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const back = await consent(clientId, challenge, "allow", allowWrite);
    const { body } = await tokenCall({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: clientId,
    });
    return { access: body.access_token as string, scope: body.scope };
  }

  async function callTool(token: string, name: string, era: "legacy" | "modern") {
    const req = mcpRequest({ token, era, method: "tools/call", params: { name, arguments: {} } });
    return (await handleMcpRequest(req, env(), REGISTRY)) as Response;
  }

  it("a grant is read only unless the owner ticks Allow changes, and lists no write tool", async () => {
    writes.length = 0;
    const read = await grant(false);
    expect(read.scope).toBe("merchant.read");
    for (const era of ["legacy", "modern"] as const) {
      expect(
        toolOutput(await readMcp(await callTool(read.access, "foxhound_get_probe", era))).isError,
      ).toBe(false);
      const listed = await readMcp(
        (await handleMcpRequest(
          mcpRequest({ token: read.access, era, method: "tools/list", params: {} }),
          env(),
          REGISTRY,
        )) as Response,
      );
      expect(JSON.stringify(listed), era).not.toContain("foxhound_update_probe");
      await callTool(read.access, "foxhound_update_probe", era);
    }
    expect(writes, "the write tool never ran").toEqual([]);

    const write = await grant(true);
    expect(write.scope).toBe("merchant.read merchant.write");
    expect(
      toolOutput(await readMcp(await callTool(write.access, "foxhound_update_probe", "legacy")))
        .isError,
    ).toBe(false);
    expect(writes).toEqual(["foxhound_update_probe"]);
  });

  it("a grant made before the split, holding no scopes, is read only", async () => {
    writes.length = 0;
    const { access } = await fullFlow();
    const [key] = await db.select().from(apiKeys);
    sqlite.prepare("UPDATE api_keys SET scopes = NULL WHERE id = ?").run(key.id);
    expect((await verifyMcpToken(db, access))!.scopes).toEqual(["merchant.read"]);
    await callTool(access, "foxhound_update_probe", "legacy");
    expect(writes, "the write tool never ran").toEqual([]);
  });
});
