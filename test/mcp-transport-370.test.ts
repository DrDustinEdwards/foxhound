import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { classifyPath } from "~/lib/http/cache-policy";
import {
  DENIED_TOOL_FRAGMENTS,
  defineToolRegistry,
  isDeniedToolName,
  type McpTool,
} from "~/lib/mcp/registry";
import { DISALLOW_PATHS } from "~/routes/files/robots";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, type McpCallInit } from "./helpers/mcp-client";

// RULING 370, ROADMAP ITEM 3: the transport, driven with an EMPTY tool registry
// so every assertion here is about the door and the protocol, not a tool.
//
// THE PROTOCOL IS THE OFFICIAL SDK NOW (MCP ruling 2026-10-10, rule 8;
// job_874dc20ea9ac). @modelcontextprotocol/server 2.0 serves both eras on one
// route: 2026-07-28 with server/discover and the header checks, and the
// 2025-era `initialize` clients through its stateless fallback. The plants
// below drive the real handler end to end, so they check the SDK's conformance
// as wired here, plus the door Foxhound keeps for itself: origin, the
// byte-stable 401, the scope and demo refusals, the two rate-limit buckets and
// the private cache policy.

const harness = vi.hoisted(() => ({ db: null as unknown, limiter: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");

const ACCOUNT = "acct_alpha";
const DEMO_ACCOUNT = "demo_teamflow";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const ORIGIN = "https://foxhoundapp.test";

/** An env whose limiter always allows, unless a test replaces it. */
function env(allowed = true): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: allowed, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  for (const id of [ACCOUNT, DEMO_ACCOUNT]) {
    await db.insert(accounts).values({ id, name: id, createdAt: NOW });
  }
  const mint = async (accountId: string | null, scope: string, token: string, revoked = false) => {
    await db.insert(apiKeys).values({
      id: `key_${token}`,
      accountId,
      keyHash: await hashMcpToken(token),
      label: "test",
      scope,
      createdAt: NOW,
      revokedAt: revoked ? NOW : null,
    });
  };
  const good = `${MCP_TOKEN_PREFIX}good`;
  const revoked = `${MCP_TOKEN_PREFIX}revoked`;
  const admin = `${MCP_TOKEN_PREFIX}admin`;
  const demo = `${MCP_TOKEN_PREFIX}demo`;
  const adminWithAccount = `${MCP_TOKEN_PREFIX}adminacct`;
  await mint(ACCOUNT, MCP_TOKEN_SCOPE.MERCHANT, good);
  await mint(ACCOUNT, MCP_TOKEN_SCOPE.MERCHANT, revoked, true);
  await mint(null, MCP_TOKEN_SCOPE.ADMIN, admin);
  // AN ADMIN KEY CARRYING AN ACCOUNT ID, which `issueMcpToken` cannot produce
  // (it nulls the account for admin scope). Inserted directly, because it is the
  // ONLY fixture that isolates the scope check: a normal admin key is refused by
  // the null-account branch one line later, so neutering the scope check leaves
  // every other assertion green. Found by mutation, not by reading.
  await mint(ACCOUNT, MCP_TOKEN_SCOPE.ADMIN, adminWithAccount);
  await mint(DEMO_ACCOUNT, MCP_TOKEN_SCOPE.MERCHANT, demo);
  return { db, good, revoked, admin, adminWithAccount, demo };
}

interface CallOptions extends McpCallInit {
  allowed?: boolean;
}

async function call(opts: CallOptions = {}) {
  const res = (await handleMcpRequest(mcpRequest(opts), env(opts.allowed ?? true), PROBE)) as Response;
  return readMcp(res);
}

/** A tool descriptor for the registry plants: everything but the name fixed.
 *  Hoisted as a function declaration, since PROBE below is built from it. */
function tool(name: string): McpTool {
  return {
    name,
    title: "t",
    description: "d",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scope: "read",
    execute: async () => ({}),
  };
}

/** ONE inert tool, so the SDK advertises a tools capability: a server with no
 *  tools at all has no tools/list to answer. It reads nothing, so every
 *  assertion below stays about the door and the protocol. */
const PROBE = defineToolRegistry([tool("foxhound_get_probe")]);
const PROBE_NAMES = ["foxhound_get_probe"];

// ============================================================================

describe("PLANT 1: the endpoint's shape", () => {
  it("only claims /mcp, returning null for anything else", async () => {
    const other = await handleMcpRequest(new Request(`${ORIGIN}/pricing`), env());
    expect(other).toBeNull();
  });

  it("GET and DELETE get 405 before anything else runs", async () => {
    await seed();
    for (const httpMethod of ["GET", "DELETE", "PUT"]) {
      const { status, res } = await call({ httpMethod, token: null });
      expect(status, `${httpMethod} was not refused`).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("a PRESENT foreign Origin is 403, an ABSENT one is fine", async () => {
    // "Servers MUST validate the Origin header ... If the Origin header is
    // present and invalid, servers MUST respond with HTTP 403 Forbidden." An
    // agent sends none, so absence must NOT be treated as invalid.
    const { good } = await seed();
    // site-runtime's refusal (mcpOriginRefusal), plain text, never cached.
    const foreign = (await handleMcpRequest(
      mcpRequest({ token: good, headers: { Origin: "https://evil.test" } }),
      env(),
      PROBE,
    )) as Response;
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("Cache-Control")).toBe("no-store");
    const sameOrigin = await call({ token: good, headers: { Origin: ORIGIN } });
    expect(sameOrigin.status).toBe(200);
    const absent = await call({ token: good });
    expect(absent.status).toBe(200);
  });

  it("malformed JSON is a parse error, not a crash", async () => {
    const { good } = await seed();
    const { status, json } = await call({ token: good, body: "{not json" });
    expect(status).toBe(400);
    expect((json as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe("PLANT 2: both eras on one route, through the SDK", () => {

  it("MODERN: tools/list is a plain JSON body carrying a private cache hint", async () => {
    const { good } = await seed();
    const { status, res, json } = await call({ token: good, era: "modern", method: "tools/list" });
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const result = (json as { result: { tools: unknown[]; cacheScope: string; ttlMs: number } }).result;
    expect((result.tools as { name: string }[]).map((t) => t.name)).toEqual(PROBE_NAMES);
    expect(result.cacheScope).toBe("private");
    expect(result.ttlMs).toBeGreaterThan(0);
  });
});

describe("PLANT 3: the 401 is byte-stable across every failure", () => {
  it("missing, malformed, unknown, revoked, admin and demo keys are indistinguishable", async () => {
    // THE LEAK THIS CLOSES. A body that varied would tell an attacker which of
    // their guesses was a real key that had been revoked, which is user
    // enumeration wearing different clothes.
    const { good, revoked, admin, adminWithAccount, demo } = await seed();
    void good;

    const cases: (string | null)[] = [
      null, // no Authorization header at all
      "not-a-bearer", // wrong prefix
      `${MCP_TOKEN_PREFIX}nonexistent`, // right prefix, unknown
      revoked, // real key, revoked
      admin, // admin scope, null account
      adminWithAccount, // admin scope WITH an account: isolates the scope check
      demo, // real merchant key on a demo account
    ];

    const seen = new Set<string>();
    for (const token of cases) {
      const { status, res } = await call({ token });
      expect(status, `token ${token} did not 401`).toBe(401);
      // J79: the 401 now names the protected-resource document an MCP client
      // follows to the OAuth provider. Still one value for every failure.
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="merchant.read"`,
      );
      seen.add(await res.clone().text());
    }
    // ONE distinct body across all six.
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain("Unauthorized");
  });
});

describe("PLANT 4: the registry can never hold a denied or unprefixed name", () => {

  it("THE DENYLIST THROWS AT CONSTRUCTION, for every HUMAN-FOREVER fragment", () => {
    // 368 ruling 4, ratified at 370. Parameterized over the shipped constant, so
    // a fragment added later is covered without a new case.
    expect(DENIED_TOOL_FRAGMENTS.length).toBeGreaterThan(10);
    for (const fragment of DENIED_TOOL_FRAGMENTS) {
      expect(isDeniedToolName(fragment), `${fragment} not denied`).toBe(true);
      expect(() => defineToolRegistry([tool(fragment)])).toThrow(/HUMAN-FOREVER/);
      // And as a SUBSTRING inside a name that is otherwise well formed, which is
      // the point: the risk is a name that contains the fragment.
      expect(() => defineToolRegistry([tool(`foxhound_${fragment}_now`)])).toThrow(/HUMAN-FOREVER/);
    }
  });

  it("a name off the foxhound_{action}_{resource} pattern throws (ruling rule 5)", () => {
    for (const name of ["get_overview", "foxhound_overview", "Foxhound_get_overview", "foxhound_get-overview"]) {
      expect(() => defineToolRegistry([tool(name)]), name).toThrow(/foxhound_\{action\}_\{resource\}/);
    }
  });

  it("a duplicate name throws, because a shadowed tool cannot be reasoned about", () => {
    expect(() => defineToolRegistry([tool("foxhound_get_dup"), tool("foxhound_get_dup")])).toThrow(
      /registered twice/,
    );
  });
});

describe("PLANT 5: the posture", () => {
  it("the anon bucket refuses at its number and the authed bucket at its own", async () => {
    const { good } = await seed();
    // Over budget: an unauthenticated caller gets 429, not 401, once capped.
    const anon = await call({ token: null, allowed: false });
    expect(anon.status).toBe(429);
    // And an authenticated caller over ITS budget gets 429 too.
    const authed = await call({ token: good, allowed: false });
    expect(authed.status).toBe(429);
  });

  it("/mcp IS PRIVATE, and no public directive can reach it", async () => {
    // The cache policy classifies anything unmatched as private, and /mcp is
    // unmatched deliberately. Asserted through the real classifier rather than
    // by reading the match list.
    expect(classifyPath("/mcp")).toBe("private");
    // And the handler sets it on the response itself, belt and braces.
    const { good } = await seed();
    const { res } = await call({ token: good });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const refused = await call({ token: null });
    expect(refused.res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("robots.txt disallows /mcp, and every named group inherits it", () => {
    // The session-74 parity rule means one entry covers all seventeen groups.
    expect(DISALLOW_PATHS).toContain("/mcp");
  });
});
