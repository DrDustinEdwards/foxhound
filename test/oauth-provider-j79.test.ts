import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeys, oauthAuthorizationCodes, oauthGrants } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_CODE_TTL_MS } from "~/lib/constants";
import { removeMember } from "~/lib/auth/account";
import { deleteUserAccountLocal } from "~/lib/auth/delete-account.server";
import { safeNextPath } from "~/lib/auth/next-path";
import { applyCachePolicy, classifyPath, NO_TRANSFORM_PREFIXES, PRIVATE_DIRECTIVE } from "~/lib/http/cache-policy";
import { authorizationServerMetadata, protectedResourceMetadata } from "~/lib/oauth/metadata";
import { isAcceptableRedirectUri, isRegisteredRedirect } from "~/lib/oauth/redirects";
import { DISALLOW_PATHS } from "~/routes/files/robots";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J79, rows A9, F18 and F19: the OAuth provider external
// agents connect through, ruling 8's build. Recova is the spec for what the
// flow allows: app/oauth/authorize/page.tsx (63884241), ConsentButtons.tsx
// (eb31e8e9), app/api/oauth/{authorize,token,register,revoke,metadata}, and
// lib/oauth.ts (e3a404cd), read whole. The engine is Foxhound's: the access
// token is a fox_mcp_ key the /mcp door already verifies, so an OAuth caller
// reaches the merchant tools and nothing else, and the account
// is the one the signed-in person had active at consent, never an argument.
//
// Every assertion drives the real functions against the committed migrations.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  allowed: true,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/auth/session", () => ({
  getSession: async () => harness.session,
}));

const provider = await import("~/lib/oauth/provider.server");
const authorizeRoute = await import("~/routes/oauth/authorize");
const tokenRoute = await import("~/routes/api/oauth-token");
const registerRoute = await import("~/routes/api/oauth-register");
const revokeRoute = await import("~/routes/api/oauth-revoke");
const metadataRoute = await import("~/routes/files/oauth-metadata");
const resourceRoute = await import("~/routes/files/oauth-protected-resource");
const { handleMcpRequest } = await import("~/lib/mcp/handler.server");

const ORIGIN = "https://foxhoundapp.test";
const USER = "user_1";
const ACCOUNT_A = "acct_a";
const ACCOUNT_B = "acct_b";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

function env(): Env {
  return {
    DB: {},
    BETTER_AUTH_URL: ORIGIN,
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: harness.allowed, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

function context(): RouterContextProvider {
  const ctx = new RouterContextProvider();
  ctx.set(cloudflareContext, { env: env(), ctx: {} as ExecutionContext, nonce: "" });
  return ctx;
}

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.allowed = true;
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(USER, "Dana", "dana@acme.test");
  for (const [id, name, at] of [
    [ACCOUNT_A, "Acme Supply Co.", 1_000],
    [ACCOUNT_B, "Beta Ltd", 2_000],
  ] as const) {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sqlite
      .prepare(
        "INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
      )
      .run(`m_${id}`, id, USER, at);
  }
  // The SECOND account is the active one, so a wrong pick of the earliest
  // membership cannot pass by accident.
  harness.session = {
    user: { id: USER, name: "Dana", email: "dana@acme.test" },
    session: { id: "sess_1", activeAccountId: ACCOUNT_B },
  };
});

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

async function registered(redirectUris: string[] = [CLAUDE_REDIRECT]): Promise<string> {
  const res = await provider.registerClient(db, { client_name: "Claude", redirect_uris: redirectUris }, NOW);
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st_123",
    ...extra,
  });
}

/** Consent through the real action, returning the code from the redirect. */
async function consent(clientId: string, challenge: string, intent = "allow"): Promise<URL> {
  const form = authorizeParams(clientId, challenge);
  form.set("intent", intent);
  // The account the card showed, posted back as a consistency check only.
  form.set("account_id", ACCOUNT_B);
  const request = new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const res = (await authorizeRoute.action({ request, context: context(), params: {} } as never)) as Response;
  expect(res.status, "the action answers with a redirect").toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return new URL(res.headers.get("Location")!);
}

async function tokenCall(fields: Record<string, string>, json = false): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
  const request = new Request(`${ORIGIN}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields),
  });
  const res = (await tokenRoute.action({ request, context: context(), params: {} } as never)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

async function fullFlow(): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = await registered();
  const { verifier, challenge } = await pkcePair();
  const back = await consent(clientId, challenge);
  const { status, body } = await tokenCall({
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
  });
  expect(status).toBe(200);
  return { clientId, access: body.access_token as string, refresh: body.refresh_token as string };
}

// ============================================================================

describe("F18 and F19: the metadata, at both of Recova's well-known paths", () => {
  it("mounts both paths on one module, as next.config.ts rewrote both to one handler", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toMatch(/route\("\.well-known\/oauth-authorization-server", "\.\/routes\/files\/oauth-metadata\.ts"/);
    expect(routes).toMatch(/route\("\.well-known\/openid-configuration", "\.\/routes\/files\/oauth-metadata\.ts"/);
  });

  it("serves Recova's fields with this request's origin as issuer", async () => {
    const res = (await metadataRoute.loader({
      request: new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      context: context(),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(authorizationServerMetadata(ORIGIN));
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
    expect(body.revocation_endpoint).toBe(`${ORIGIN}/api/oauth/revoke`);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.scopes_supported).toEqual(["merchant"]);
  });

  it("advertises no endpoint that does not exist (RULES.md 2.7)", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    const body = authorizationServerMetadata(ORIGIN) as Record<string, unknown>;
    const endpoints = Object.entries(body).filter(([k]) => k.endsWith("_endpoint"));
    expect(endpoints.length).toBe(4);
    for (const [key, url] of endpoints) {
      const path = new URL(url as string).pathname.slice(1);
      expect(routes, `${key} names a route`).toContain(`route("${path}",`);
    }
  });
});

describe("the protected-resource document and the /mcp 401 that points at it", () => {
  it("names /mcp and this origin as its authorization server", async () => {
    const res = (await resourceRoute.loader({
      request: new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
      context: context(),
      params: {},
    } as never)) as Response;
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(protectedResourceMetadata(ORIGIN));
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.scopes_supported).toEqual(["merchant"]);
    expect(body).not.toHaveProperty("resource_signing_alg_values_supported");
  });

  it("is mounted at the bare path and at the /mcp suffix RFC 9728 clients try", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toMatch(/route\("\.well-known\/oauth-protected-resource", "\.\/routes\/files\/oauth-protected-resource\.ts"/);
    expect(routes).toMatch(/route\("\.well-known\/oauth-protected-resource\/mcp", "\.\/routes\/files\/oauth-protected-resource\.ts"/);
  });
});

describe("registration (RFC 7591)", () => {

  it("answers Recova's shape, defaults included", async () => {
    const res = await provider.registerClient(db, { redirect_uris: [CLAUDE_REDIRECT] }, NOW);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_name: "OAuth Client",
      redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a body with no usable redirect URI", async () => {
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: "x" }, { redirect_uris: [7] }]) {
      const res = await provider.registerClient(db, body, NOW);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    }
  });

  it("refuses script, data and plain-http redirect URIs, and fragments", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost:53682/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1/callback")).toBe(true);
    expect(isAcceptableRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("data:text/html,hi")).toBe(false);
    expect(isAcceptableRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAcceptableRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAcceptableRedirectUri("not a url")).toBe(false);
  });

  it("the route answers 201 and 429 once over Recova's 10 an hour", async () => {
    const call = async () =>
      (await registerRoute.action({
        request: new Request(`${ORIGIN}/api/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT] }),
        }),
        context: context(),
        params: {},
      } as never)) as Response;
    expect((await call()).status).toBe(201);
    harness.allowed = false;
    expect((await call()).status).toBe(429);
  });
});

describe("Recova's redirect match: exact, except loopback ports (RFC 8252)", () => {
  it("matches a loopback URI on any port and everything else exactly", () => {
    expect(isRegisteredRedirect("http://localhost:53682/callback", ["http://localhost/callback"])).toBe(true);
    expect(isRegisteredRedirect("http://127.0.0.1:9/cb", ["http://127.0.0.1:1234/cb"])).toBe(true);
    expect(isRegisteredRedirect("https://claude.ai/cb", ["https://claude.ai/cb"])).toBe(true);
    expect(isRegisteredRedirect("https://claude.ai:8443/cb", ["https://claude.ai/cb"])).toBe(false);
    expect(isRegisteredRedirect("http://localhost/other", ["http://localhost/callback"])).toBe(false);
  });
});

describe("A9: the authorize request is checked in Recova's order, with Recova's words", () => {
  it("names each refusal as Recova's ErrorPage did", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ client_id: "" }, "Invalid request", "Missing client_id or redirect_uri."],
      [{ redirect_uri: "" }, "Invalid request", "Missing client_id or redirect_uri."],
      [{ response_type: "token" }, "Unsupported response_type", "Only response_type=code is supported."],
      [{ code_challenge: "" }, "PKCE required", "This authorization server requires PKCE with code_challenge_method=S256."],
      [{ code_challenge_method: "plain" }, "PKCE required", "This authorization server requires PKCE with code_challenge_method=S256."],
      [{ client_id: "00000000-0000-0000-0000-000000000000" }, "Unknown client", "This client is not registered with Foxhound."],
      [{ redirect_uri: "https://evil.example/cb" }, "Invalid redirect URI", "The redirect_uri does not match any URI registered for this client."],
    ];
    for (const [override, title, message] of cases) {
      const params = authorizeParams(clientId, challenge, override);
      for (const [k, v] of Object.entries(override)) if (v === "") params.delete(k);
      const check = await provider.checkAuthorizeRequest(db, params);
      expect(check, JSON.stringify(override)).toEqual({ ok: false, title, message });
    }
    const good = await provider.checkAuthorizeRequest(db, authorizeParams(clientId, challenge));
    expect(good).toMatchObject({ ok: true, clientId, clientName: "Claude", redirectUri: CLAUDE_REDIRECT, state: "st_123" });
  });

  it("a signed-out visitor goes to /login with EVERY parameter kept, resource included", async () => {
    harness.session = null;
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const params = authorizeParams(clientId, challenge, { resource: `${ORIGIN}/mcp`, prompt: "consent" });
    const url = `${ORIGIN}/oauth/authorize?${params}`;
    let thrown: unknown;
    try {
      await authorizeRoute.loader({ request: new Request(url), context: context(), params: {} } as never);
    } catch (e) {
      thrown = e;
    }
    const res = thrown as Response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, ORIGIN);
    expect(location.pathname).toBe("/login");
    const next = new URL(location.searchParams.get("next")!, ORIGIN);
    expect(next.pathname).toBe("/oauth/authorize");
    for (const [k, v] of params) expect(next.searchParams.get(k), k).toBe(v);
  });

  it("a signed-in visitor sees the ACTIVE account, never the earliest", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const data = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as { ok: true; accountName: string; email: string; clientName: string };
    expect(data).toMatchObject({ ok: true, accountName: "Beta Ltd", email: "dana@acme.test", clientName: "Claude" });
  });

  it("a signed-in visitor with no account goes to /connect, as Recova sent them", async () => {
    sqlite.prepare("DELETE FROM account_members").run();
    const clientId = await registered();
    const { challenge } = await pkcePair();
    let thrown: unknown;
    try {
      await authorizeRoute.loader({
        request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
        context: context(),
        params: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Response).headers.get("Location")).toBe("/connect");
  });
});

describe("A9: consent", () => {
  it("Allow mints a code for the active account and returns state", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const back = await consent(clientId, challenge);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st_123");
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.select().from(oauthAuthorizationCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(ACCOUNT_B);
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].codeHash).not.toBe(back.searchParams.get("code"));
  });

  it("Deny goes back with access_denied and the state, and mints nothing", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const back = await consent(clientId, challenge, "deny");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st_123");
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("the card's account is posted back and checked, never used: a mismatch is refused and binds nothing", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const loaded = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as { accountId: string };
    expect(loaded.accountId).toBe(ACCOUNT_B);
    // The merchant switched to another account in a second tab after the card
    // rendered (or the field was tampered with, or is missing): refused.
    for (const shown of [ACCOUNT_A, null]) {
      const form = authorizeParams(clientId, challenge, { intent: "allow" });
      if (shown) form.set("account_id", shown);
      const res = (await authorizeRoute.action({
        request: new Request(`${ORIGIN}/oauth/authorize`, { method: "POST", headers: { Origin: ORIGIN }, body: form }),
        context: context(),
        params: {},
      } as never)) as { data?: { error?: string }; init?: { status?: number } } | Response;
      expect(res instanceof Response, `shown=${shown}`).toBe(false);
      expect((res as { init: { status: number } }).init.status, `shown=${shown}`).toBe(409);
    }
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
    // The matching account goes through, and is the session's.
    const back = await consent(clientId, challenge);
    expect(back.searchParams.get("code")).toBeTruthy();
    const [row] = await db.select().from(oauthAuthorizationCodes);
    expect(row.accountId).toBe(ACCOUNT_B);
  });

  it("a member, not the owner, is refused on the card and on Allow, and nothing is minted", async () => {
    sqlite.prepare("UPDATE account_members SET role = 'member' WHERE account_id = ?").run(ACCOUNT_B);
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const loaded = (await authorizeRoute.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${authorizeParams(clientId, challenge)}`),
      context: context(),
      params: {},
    } as never)) as { ok: boolean };
    expect(loaded.ok).toBe(false);
    const form = authorizeParams(clientId, challenge, { intent: "allow", account_id: ACCOUNT_B });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, { method: "POST", headers: { Origin: ORIGIN }, body: form }),
      context: context(),
      params: {},
    } as never)) as { init?: { status?: number } } | Response;
    expect(res instanceof Response ? res.status : res.init?.status).toBe(403);
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("a post from another origin is refused before anything is minted", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const form = authorizeParams(clientId, challenge, { intent: "allow" });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: form,
      }),
      context: context(),
      params: {},
    } as never)) as { init?: { status?: number } } | Response;
    const status = res instanceof Response ? res.status : res.init?.status;
    expect(status).toBe(403);
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });

  it("a tampered redirect URI in the form is refused, never followed", async () => {
    const clientId = await registered();
    const { challenge } = await pkcePair();
    const form = authorizeParams(clientId, challenge, { intent: "allow", redirect_uri: "https://evil.example/cb" });
    const res = (await authorizeRoute.action({
      request: new Request(`${ORIGIN}/oauth/authorize`, { method: "POST", headers: { Origin: ORIGIN }, body: form }),
      context: context(),
      params: {},
    } as never)) as { data?: { error?: string }; init?: { status?: number } } | Response;
    expect(res instanceof Response).toBe(false);
    expect((res as { data: { error: string } }).data.error).toBeTruthy();
    expect(await db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
  });
});

describe("the token endpoint", () => {
  it("issues a one-hour merchant key for the consenting account, which /mcp accepts", async () => {
    const { access, refresh } = await fullFlow();
    expect(access.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(refresh.startsWith("fox_rt_")).toBe(true);
    const verified = await verifyMcpToken(db, access);
    expect(verified).toMatchObject({ accountId: ACCOUNT_B, scope: MCP_TOKEN_SCOPE.MERCHANT });
    const [key] = await db.select().from(apiKeys);
    expect(key.expiresAt!.getTime() - key.createdAt.getTime()).toBe(OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
    expect(key.label).toBe("Claude (OAuth)");

    const res = (await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      }),
      env(),
    )) as Response;
    expect(res.status).toBe(200);
  });

  it("answers Recova's token response with no-store", async () => {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const back = await consent(clientId, challenge);
    const { status, body, res } = await tokenCall(
      { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId },
      true,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "merchant" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });

  it("refuses a wrong verifier, a wrong client, a wrong redirect and an expired code", async () => {
    const clientId = await registered();
    const other = await registered();
    const bad = async (fields: (code: string, verifier: string) => Record<string, string>, label: string, at?: Date) => {
      const { verifier, challenge } = await pkcePair();
      const code = (await consent(clientId, challenge)).searchParams.get("code")!;
      const res = at
        ? await provider.exchangeToken(db, new URLSearchParams(fields(code, verifier)), at)
        : (await tokenCall(fields(code, verifier)));
      expect(res.status, label).toBe(400);
      expect(res.body.error, label).toBe("invalid_grant");
    };
    await bad((code) => ({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: clientId }), "verifier");
    await bad((code, v) => ({ grant_type: "authorization_code", code, code_verifier: v, client_id: other }), "client");
    await bad((code, v) => ({ grant_type: "authorization_code", code, code_verifier: v, client_id: clientId, redirect_uri: "https://claude.ai/other" }), "redirect");
    await bad(
      (code, v) => ({ grant_type: "authorization_code", code, code_verifier: v, client_id: clientId }),
      "expired",
      new Date(Date.now() + OAUTH_CODE_TTL_MS + 1000),
    );
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it("a code used twice is refused and kills what the first use made", async () => {
    const clientId = await registered();
    const { verifier, challenge } = await pkcePair();
    const code = (await consent(clientId, challenge)).searchParams.get("code")!;
    const fields = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId };
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
      request: new Request(`${ORIGIN}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }),
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
    const next = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(refresh);
    expect(await verifyMcpToken(db, access)).toBeNull();
    expect(await verifyMcpToken(db, next.body.access_token as string)).toMatchObject({ accountId: ACCOUNT_B });
    expect(await db.select().from(apiKeys)).toHaveLength(1);
  });

  it("presenting a replaced refresh token revokes the grant", async () => {
    const { clientId, refresh } = await fullFlow();
    const next = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    const replay = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await verifyMcpToken(db, next.body.access_token as string)).toBeNull();
    const again = await tokenCall({ grant_type: "refresh_token", refresh_token: next.body.refresh_token as string, client_id: clientId });
    expect(again.body.error).toBe("invalid_grant");
  });

  it("a key revoked in Settings cannot be refreshed back to life", async () => {
    const { clientId, refresh } = await fullFlow();
    await db.update(apiKeys).set({ revokedAt: new Date() });
    const res = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("refuses another client's refresh token", async () => {
    const { refresh } = await fullFlow();
    const other = await registered();
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: other })).body.error).toBe("invalid_grant");
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
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: two.refresh, client_id: two.clientId })).body.error).toBe("invalid_grant");
  });
});

describe("the shared cache policy owns the private responses (test/cache-policy.test.ts PLANT 7)", () => {
  it("the protected-resource document and revocation get the policy's private, no-store", async () => {
    const prmReq = new Request(`${ORIGIN}/.well-known/oauth-protected-resource`);
    const prm = applyCachePolicy(prmReq, (await resourceRoute.loader({ request: prmReq } as never)) as Response);
    expect(prm.headers.get("Cache-Control")).toBe(PRIVATE_DIRECTIVE);
    expect(prm.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const revReq = new Request(`${ORIGIN}/api/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "fox_rt_unknown" }),
    });
    const rev = applyCachePolicy(revReq, (await revokeRoute.action({ request: revReq, context: context(), params: {} } as never)) as Response);
    expect(rev.status).toBe(200);
    expect(rev.headers.get("Cache-Control")).toBe(PRIVATE_DIRECTIVE);
  });
});

describe("the authorize page stays out of caches, analytics and crawls", () => {
  it("is private, carries no analytics, and Recova's robots line returns", () => {
    expect(classifyPath("/oauth/authorize")).toBe("private");
    expect(NO_TRANSFORM_PREFIXES).toContain("/oauth/");
    expect(DISALLOW_PATHS).toContain("/oauth/");
  });
});

// ============================================================================
// A grant is one person's delegation: it lasts only while that person is still
// an active member of the account (fresh review of PR #141, B2).

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
    const res = await tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
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
    const res = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("a closed account's access token stops working", async () => {
    const { access } = await fullFlow();
    expect(await verifyMcpToken(db, access)).not.toBeNull();
    sqlite.prepare("UPDATE accounts SET cancelled_at = ? WHERE id = ?").run(NOW.getTime(), ACCOUNT_B);
    expect(await verifyMcpToken(db, access)).toBeNull();
  });

  it("a membership gone by any other path: the next refresh refuses and revokes", async () => {
    const { clientId, access, refresh } = await fullFlow();
    sqlite.prepare("DELETE FROM account_members WHERE id = ?").run(`m_${ACCOUNT_B}`);
    const res = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(await verifyMcpToken(db, access)).toBeNull();
    const [grant] = await db.select().from(oauthGrants);
    expect(grant.revokedAt).not.toBeNull();
  });

  it("deleting the person ends their grant on an account they do not own, under foreign keys", async () => {
    sqlite.pragma("foreign_keys = ON");
    sqlite
      .prepare("INSERT INTO user (id, name, email, email_verified, updated_at) VALUES ('user_2', 'Eli', 'eli@acme.test', 0, 0)")
      .run();
    sqlite
      .prepare("INSERT INTO account_members (id, account_id, user_id, role, status, created_at) VALUES ('m_eli', ?, 'user_2', 'owner', 'active', 3000)")
      .run(ACCOUNT_B);
    harness.session = { user: { id: "user_2", name: "Eli", email: "eli@acme.test" }, session: { id: "s2", activeAccountId: ACCOUNT_B } };
    const elis = await fullFlow();
    // Eli consented as an owner and is an ordinary member when deleted.
    sqlite.prepare("UPDATE account_members SET role = 'member' WHERE id = 'm_eli'").run();
    const result = await deleteUserAccountLocal(db, "user_2", new Date());
    expect(result.status).toBe("deleted");
    expect(await verifyMcpToken(db, elis.access)).toBeNull();
    expect(await db.select().from(oauthGrants)).toHaveLength(0);
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: elis.refresh, client_id: elis.clientId })).body.error).toBe("invalid_grant");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("redirect schemes: an operating-system handler is never a client", () => {
  it("refuses Windows and other OS protocol handlers, keeps real clients' schemes", () => {
    for (const uri of [
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "ms-settings:privacy",
      "ms-officecmd:x",
      "ms-word:ofe|u|https://evil.example/a.docx",
      "shell:startup",
      "mk:@MSITStore:x",
      "its:x",
      "hcp://x",
      "jar:https://evil.example/a.jar!/",
      "view-source:https://evil.example",
      "filesystem:https://evil.example/x",
      "ftp://evil.example/cb",
      "mailto:a@example.com",
      "tel:123",
      "sms:123",
      "intent://x#Intent;end",
    ]) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(false);
    }
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:43123/callback",
      "http://127.0.0.1/callback",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
      "com.example.agent:/oauth/callback",
    ]) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(true);
    }
  });
});

describe("safeNextPath never hands a Location header a value it cannot carry", () => {
  it("refuses any character outside printable ASCII", () => {
    for (const raw of ["/\u3000/x", "/\u00a0/x", "/caf\u00e9", "/\u2028x", "%2F%E3%80%80%2Fx"]) {
      expect(safeNextPath(JSON.parse(`"${raw}"`)), raw).toBe("/console");
    }
    expect(safeNextPath("/oauth/authorize?a=%E3%80%80")).toBe("/oauth/authorize?a=%E3%80%80");
  });
});
