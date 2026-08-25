import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { RATE_LIMIT_MCP, RATE_LIMIT_MCP_ANON } from "~/lib/constants";
import { classifyPath } from "~/lib/http/cache-policy";
import {
  MCP_ERROR,
  MCP_PROTOCOL_VERSION,
  decodeHeaderValue,
  validateMcpRequest,
} from "~/lib/mcp/protocol";
import { DENIED_TOOL_FRAGMENTS, defineToolRegistry, isDeniedToolName } from "~/lib/mcp/registry";
import { DISALLOW_PATHS } from "~/routes/files/robots";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 370, ROADMAP ITEM 3, FIRST OF TWO: the transport, with an EMPTY tool
// registry.
//
// THE ENDPOINT IS HAND-ROLLED, ratified by Dustin in session 76 against the
// measurement: installing `agents@0.21.0` forces a tree-wide npm re-resolution
// that surfaces a pre-existing latent conflict (`@sentry/cloudflare@10.65.0`
// wants `peerOptional @cloudflare/workers-types@^4.x`, the tree carries
// `5.20260825.1`), and resolving that needs --legacy-peer-deps or an overrides
// pin on a repo that moves money. A plain `npm install` on the current tree is
// clean, so `agents` exposes the conflict rather than causing it.
//
// SO SPEC CONFORMANCE IS FOXHOUND'S NOW, and these plants are what carries it.
// Every assertion below cites the clause of the 2026-07-28 revision it encodes,
// read at build time this session and not recalled.

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
      get: () => ({ check: async () => ({ allowed, retryAfterSec: 60 }) }),
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

interface CallOptions {
  token?: string | null;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  httpMethod?: string;
  modern?: boolean;
  allowed?: boolean;
}

async function call(opts: CallOptions = {}): Promise<{ status: number; json: never; res: Response }> {
  const method = opts.method ?? "tools/list";
  const body =
    opts.body !== undefined
      ? opts.body
      : {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: opts.modern
            ? { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION } }
            : {},
        };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
  if (opts.token !== null && opts.token !== undefined) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.modern) {
    headers["MCP-Protocol-Version"] ??= MCP_PROTOCOL_VERSION;
    headers["Mcp-Method"] ??= method;
  }
  const res = (await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: opts.httpMethod ?? "POST",
      headers,
      body: opts.httpMethod === "GET" ? undefined : JSON.stringify(body),
    }),
    env(opts.allowed ?? true),
  )) as Response;
  const text = await res.clone().text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as never, res };
}

// ============================================================================

describe("PLANT 1: the endpoint's shape, per the 2026-07-28 binding", () => {
  it("only claims /mcp, returning null for anything else", async () => {
    const other = await handleMcpRequest(new Request(`${ORIGIN}/pricing`), env());
    expect(other).toBeNull();
  });

  it("GET and DELETE get 405, per the Earlier Revisions clause", async () => {
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

  it("an unknown METHOD is 404 with -32601, not 400", async () => {
    // "If the server does not implement the requested RPC method, it MUST
    // respond with 404 Not Found and a JSON-RPC error with code -32601."
    const { good } = await seed();
    const { status, json } = await call({ token: good, method: "resources/list" });
    expect(status).toBe(404);
    expect((json as { error: { code: number } }).error.code).toBe(MCP_ERROR.METHOD_NOT_FOUND);
  });

  it("a NOTIFICATION is 202 with no body", async () => {
    // "If the body is a JSON-RPC notification ... the server MUST return HTTP
    // status code 202 Accepted with no body."
    const { good } = await seed();
    const { status, res } = await call({
      token: good,
      body: { jsonrpc: "2.0", method: "tools/list" },
    });
    expect(status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("malformed JSON is a parse error, not a crash", async () => {
    const { good } = await seed();
    const res = (await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${good}`, "Content-Type": "application/json" },
        body: "{not json",
      }),
      env(),
    )) as Response;
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: number } }).error.code).toBe(MCP_ERROR.PARSE);
  });
});

describe("PLANT 2: both eras on one route", () => {
  it("MODERN: the header round-trips and the version is echoed", async () => {
    const { good } = await seed();
    const { status, res, json } = await call({ token: good, modern: true, method: "tools/list" });
    expect(status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION);
    expect((json as { result: { tools: unknown[] } }).result.tools).toEqual([]);
  });

  it("LEGACY: initialize round-trips the protocol version", async () => {
    // The older revisions open with an `initialize` handshake and send no
    // MCP-Protocol-Version header. A modern-only endpoint would be conformant
    // and unusable, because that is what the clients that exist today speak.
    const { good } = await seed();
    const { status, json } = await call({
      token: good,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      },
    });
    expect(status).toBe(200);
    const result = (json as { result: { protocolVersion: string; serverInfo: { name: string } } })
      .result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("foxhound");
  });

  it("an initialize for a version we do not serve answers with ours", async () => {
    const { good } = await seed();
    const { json } = await call({
      token: good,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    });
    expect((json as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      MCP_PROTOCOL_VERSION,
    );
  });

  it("HEADER MISMATCH is 400 with -32020, on each mirrored header", () => {
    // "Servers MUST reject requests where the values specified in the headers do
    // not match the corresponding values in the request body ... MUST return
    // HTTP status 400 Bad Request and MUST include ... code -32020."
    const headers = (h: Record<string, string>) => new Headers(h);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "a_tool",
        _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION },
      },
    };

    // Version header disagreeing with _meta.
    const v = validateMcpRequest(
      headers({
        "mcp-protocol-version": "2025-06-18",
        "mcp-method": "tools/call",
        "mcp-name": "a_tool",
      }),
      body,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.refusal.code).toBe(MCP_ERROR.HEADER_MISMATCH);

    // Method header disagreeing with the body.
    const m = validateMcpRequest(
      headers({
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/list",
        "mcp-name": "a_tool",
      }),
      body,
    );
    expect(m.ok === false && m.refusal.code).toBe(MCP_ERROR.HEADER_MISMATCH);

    // Mcp-Name missing on a named method.
    const n = validateMcpRequest(
      headers({ "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-method": "tools/call" }),
      body,
    );
    expect(n.ok === false && n.refusal.code).toBe(MCP_ERROR.HEADER_MISMATCH);

    // And the correct set validates, so the refusals above discriminate.
    const good = validateMcpRequest(
      headers({
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "a_tool",
      }),
      body,
    );
    expect(good.ok).toBe(true);
    expect(good.ok === true && good.era).toBe("modern");
  });

  it("the Base64 sentinel is decoded before comparison, as the spec requires", () => {
    // "Servers MUST decode an encoded Mcp-Name ... value before comparing it to
    // the corresponding request body value." Skipping this rejects legitimate
    // non-ASCII tool names.
    const encoded = "=?base64?" + btoa("Hello") + "?=";
    expect(decodeHeaderValue(encoded)).toBe("Hello");
    expect(decodeHeaderValue("plain")).toBe("plain");
    const v = validateMcpRequest(
      new Headers({
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": encoded,
      }),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Hello" } },
    );
    expect(v.ok).toBe(true);
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
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
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
    expect((json as { result: { tools: unknown[] } }).result.tools).toEqual([]);
  });
});

describe("PLANT 4: the registry is EMPTY and can never hold a denied name", () => {
  it("tools/list is empty and tools/call refuses every name", async () => {
    const { good } = await seed();
    const { json } = await call({ token: good, method: "tools/list" });
    expect((json as { result: { tools: unknown[] } }).result.tools).toEqual([]);

    for (const name of ["list_audit_runs", "anything", ""]) {
      const res = await call({
        token: good,
        method: "tools/call",
        body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name } },
      });
      expect(res.status, `${name} was not refused`).toBe(404);
      expect((res.json as { error: { code: number } }).error.code).toBe(MCP_ERROR.METHOD_NOT_FOUND);
    }
  });

  it("THE DENYLIST THROWS AT CONSTRUCTION, for every HUMAN-FOREVER fragment", () => {
    // 368 ruling 4, ratified at 370. Parameterized over the shipped constant, so
    // a fragment added later is covered without a new case.
    expect(DENIED_TOOL_FRAGMENTS.length).toBeGreaterThan(10);
    for (const fragment of DENIED_TOOL_FRAGMENTS) {
      expect(isDeniedToolName(fragment), `${fragment} not denied`).toBe(true);
      expect(() =>
        defineToolRegistry([
          { name: fragment, description: "d", inputSchema: { type: "object" } },
        ]),
      ).toThrow(/HUMAN-FOREVER/);
      // And as a SUBSTRING, which is the point: the risk is a name that contains
      // the fragment, not one that equals it.
      expect(() =>
        defineToolRegistry([
          { name: `merchant_${fragment}_v2`, description: "d", inputSchema: { type: "object" } },
        ]),
      ).toThrow(/HUMAN-FOREVER/);
    }
  });

  it("the five named refusals each have a fragment that catches them", () => {
    for (const name of [
      "submit_dispute_evidence",
      "cancel_account",
      "disconnect_stripe",
      "connect_stripe_account",
      "create_api_key",
      "record_outcome",
    ]) {
      expect(isDeniedToolName(name), `${name} would be registrable`).toBe(true);
    }
  });

  it("AND AN ORDINARY READ TOOL IS ACCEPTED, so the denylist is not deny-everything", () => {
    // The non-vacuous half. A denylist that rejected every name would satisfy
    // every assertion above and make session 77 impossible.
    const registry = defineToolRegistry([
      { name: "list_audit_runs", description: "d", inputSchema: { type: "object" } },
      { name: "get_intelligence_overview", description: "d", inputSchema: { type: "object" } },
    ]);
    expect(registry.list().map((t) => t.name)).toEqual([
      "list_audit_runs",
      "get_intelligence_overview",
    ]);
    expect(registry.get("list_audit_runs")).not.toBeNull();
    expect(registry.get("nope")).toBeNull();
  });

  it("a duplicate name throws, because a shadowed tool cannot be reasoned about", () => {
    expect(() =>
      defineToolRegistry([
        { name: "dup", description: "d", inputSchema: { type: "object" } },
        { name: "dup", description: "d", inputSchema: { type: "object" } },
      ]),
    ).toThrow(/registered twice/);
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
    const res = (await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${good}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      broken,
    )) as Response;
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
