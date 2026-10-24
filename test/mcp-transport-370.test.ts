import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { RATE_LIMIT_MCP, RATE_LIMIT_MCP_ANON } from "~/lib/constants";
import { classifyPath } from "~/lib/http/cache-policy";
import {
  DENIED_TOOL_FRAGMENTS,
  defineToolRegistry,
  isDeniedToolName,
  type McpTool,
} from "~/lib/mcp/registry";
import { DISALLOW_PATHS } from "~/routes/files/robots";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { MODERN_VERSION, mcpRequest, readMcp, type McpCallInit } from "./helpers/mcp-client";

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
    const foreign = await call({ token: good, headers: { Origin: "https://evil.test" } });
    expect(foreign.status).toBe(403);
    const sameOrigin = await call({ token: good, headers: { Origin: ORIGIN } });
    expect(sameOrigin.status).toBe(200);
    const absent = await call({ token: good });
    expect(absent.status).toBe(200);
  });

  it("an unknown METHOD is refused with -32601 on both eras", async () => {
    const { good } = await seed();
    for (const era of ["legacy", "modern"] as const) {
      const { json } = await call({ token: good, era, method: "resources/list" });
      expect((json as { error: { code: number } }).error.code, era).toBe(-32601);
    }
  });

  it("a NOTIFICATION is 202 with no body", async () => {
    const { good } = await seed();
    const { status, res } = await call({ token: good, id: null, method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("malformed JSON is a parse error, not a crash", async () => {
    const { good } = await seed();
    const { status, json } = await call({ token: good, body: "{not json" });
    expect(status).toBe(400);
    expect((json as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe("PLANT 2: both eras on one route, through the SDK", () => {
  it("MODERN: server/discover names 2026-07-28 and the server", async () => {
    const { good } = await seed();
    const { status, json } = await call({ token: good, era: "modern", method: "server/discover" });
    expect(status).toBe(200);
    const result = (json as {
      result: { supportedVersions: string[]; _meta: Record<string, { name: string }> };
    }).result;
    expect(result.supportedVersions).toContain(MODERN_VERSION);
    expect(result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("foxhound");
  });

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

  it("LEGACY: initialize round-trips the protocol version", async () => {
    // The older revisions open with an `initialize` handshake and send no
    // MCP-Protocol-Version header. A modern-only endpoint would be conformant
    // and unusable, because that is what the clients that exist today speak.
    const { good } = await seed();
    const { status, json } = await call({
      token: good,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
    });
    expect(status).toBe(200);
    const result = (json as { result: { protocolVersion: string; serverInfo: { name: string } } })
      .result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("foxhound");
  });

  it("HEADER MISMATCH is 400 with -32020, on each mirrored header", async () => {
    // "Servers MUST reject requests where the values specified in the headers do
    // not match the corresponding values in the request body ... MUST return
    // HTTP status 400 Bad Request and MUST include ... code -32020."
    const { good } = await seed();
    const base: McpCallInit = {
      token: good,
      era: "modern",
      method: "tools/call",
      params: { name: "foxhound_a_tool", arguments: {} },
    };
    const mismatches: Record<string, string>[] = [
      { "Mcp-Method": "tools/list" },
      { "Mcp-Name": "foxhound_other_tool" },
    ];
    for (const headers of mismatches) {
      const { status, json } = await call({ ...base, headers });
      expect(status, JSON.stringify(headers)).toBe(400);
      expect((json as { error: { code: number } }).error.code).toBe(-32020);
    }
    // And the matching set reaches the server, so the refusals discriminate:
    // the registry answers that the tool does not exist, not -32020.
    const { json } = await call(base);
    expect((json as { error?: { code: number } }).error?.code).not.toBe(-32020);
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
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="merchant"`,
      );
      seen.add(await res.clone().text());
    }
    // ONE distinct body across all six.
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain("Unauthorized");
  });

  it("THE SCOPE CHECK IS LOAD-BEARING ON ITS OWN, not masked by the null account", async () => {
    // A normal admin key has a null account and is refused one line later, so
    // this is the only case that proves the scope check discriminates. Its
    // absence let a mutation of that check pass green; the fixture exists
    // because of that mutation.
    const { adminWithAccount } = await seed();
    const { status } = await call({ token: adminWithAccount });
    expect(status).toBe(401);
  });

  it("and a VALID key reaches the registry, so the refusals are the guard", async () => {
    const { good } = await seed();
    const { status, json } = await call({ token: good, method: "tools/list" });
    expect(status).toBe(200);
    const tools = (json as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(PROBE_NAMES);
  });
});

describe("PLANT 4: the registry can never hold a denied or unprefixed name", () => {
  it("tools/call refuses every name the registry does not hold", async () => {
    const { good } = await seed();
    for (const name of ["foxhound_get_overview", "anything"]) {
      const res = await call({ token: good, method: "tools/call", params: { name, arguments: {} } });
      const error = (res.json as { error?: { message: string } }).error;
      expect(error?.message, `${name} was not refused`).toContain("not found");
    }
  });

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

  it("the five named refusals each have a fragment that catches them", () => {
    for (const name of [
      "foxhound_submit_dispute_evidence",
      "foxhound_cancel_account",
      "foxhound_disconnect_stripe",
      "foxhound_connect_stripe_account",
      "foxhound_create_api_key",
      "foxhound_record_outcome",
      "foxhound_trigger_charge",
      "foxhound_issue_refund",
    ]) {
      expect(isDeniedToolName(name), `${name} would be registrable`).toBe(true);
    }
  });

  it("a name off the foxhound_{action}_{resource} pattern throws (ruling rule 5)", () => {
    for (const name of ["get_overview", "foxhound_overview", "Foxhound_get_overview", "foxhound_get-overview"]) {
      expect(() => defineToolRegistry([tool(name)]), name).toThrow(/foxhound_\{action\}_\{resource\}/);
    }
  });

  it("AND AN ORDINARY READ TOOL IS ACCEPTED, so the denylist is not deny-everything", () => {
    const registry = defineToolRegistry([tool("foxhound_review_audits"), tool("foxhound_get_overview")]);
    expect(registry.list().map((t) => t.name)).toEqual(["foxhound_review_audits", "foxhound_get_overview"]);
    expect(registry.get("foxhound_review_audits")).not.toBeNull();
    expect(registry.get("nope")).toBeNull();
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

  it("FAILS OPEN on a limiter error, per 311's precedent", async () => {
    const { good } = await seed();
    const broken = {
      DB: {},
      RATE_LIMITER: {
        idFromName: () => {
          throw new Error("DO down");
        },
        get: () => {
          throw new Error("DO down");
        },
      },
    } as unknown as Env;
    const res = (await handleMcpRequest(mcpRequest({ token: good }), broken)) as Response;
    // A limiter outage must not take down a merchant's integration.
    expect(res.status).toBe(200);
  });

  it("the two buckets carry the numbers the record states", () => {
    expect(RATE_LIMIT_MCP).toEqual({ max: 120, windowMs: 60_000 });
    expect(RATE_LIMIT_MCP_ANON).toEqual({ max: 20, windowMs: 60_000 });
    // The anon bucket is TIGHTER than the authed one, which is the whole design.
    expect(RATE_LIMIT_MCP_ANON.max).toBeLessThan(RATE_LIMIT_MCP.max);
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
