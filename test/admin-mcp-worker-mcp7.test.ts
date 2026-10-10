import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkRegistration, DCR_REDIRECT_URIS, registrationLimited } from "../mcp/src/registration";
import { SCOPE_READ, SCOPE_WRITE, grantScopes } from "../mcp/src/scopes";
import { ADMIN_TOOLS, ADMIN_TOOL_NAMES } from "../mcp/src/tools";
import { serveAdminMcp } from "../mcp/src/server";
import { guardMcpRequest, isFoxhoundAdmin } from "../mcp/src/guard";

import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// JOB job_21de68b30fc2, PR 2: THE FOXHOUND ADMIN MCP, its own Worker at
// admin-mcp.foxhoundapp.com (MCP ruling 2026-10-10, rule 9 amendment).
//
// THE WORKER HOLDS NOTHING THAT MOVES MONEY. No Stripe key, no money binding,
// no D1. Its one way into Foxhound is the admin API (PR 1) over a service
// binding, carrying the admin key and the signed-in admin's email on every
// call, and that API re-checks the admin and offers only reads, pause and
// staging. These plants hold the Worker to that shape, the nine tools to the
// ruling, and the door to rules 12 and 13.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");
const strip = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
const jsonc = (source: string) => JSON.parse(strip(source).replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;

const ADMIN = "dustin@foxhound.test";
const KEY = "fox_mcp_test_admin_key";

interface ApiCall {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  actor: string | null;
  body: unknown;
}

/** A fake FOXHOUND service binding that records every call and answers from a script. */
function fakeFoxhound(answer: (call: ApiCall) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, data: {} } })) {
  const calls: ApiCall[] = [];
  return {
    calls,
    binding: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        const call: ApiCall = {
          method: request.method,
          path: url.pathname,
          search: url.search,
          auth: request.headers.get("authorization"),
          actor: request.headers.get("foxhound-acting-admin"),
          body: request.method === "POST" ? await request.json() : null,
        };
        calls.push(call);
        const { status, body } = answer(call);
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      },
    },
  };
}

function env(binding: { fetch(request: Request): Promise<Response> }) {
  return { FOXHOUND: binding, FOXHOUND_ADMIN_API_KEY: KEY } as never;
}

async function callTool(
  binding: { fetch(request: Request): Promise<Response> },
  name: string,
  args: Record<string, unknown>,
  scopes: string[] = [SCOPE_READ, SCOPE_WRITE],
) {
  const res = await serveAdminMcp(mcpRequest({ method: "tools/call", params: { name, arguments: args } }), env(binding), {
    actor: ADMIN,
    client: "test client",
    scopes,
  });
  return toolOutput(await readMcp(res));
}

// ============================================================================

describe("PLANT 1: the Worker holds no Stripe key, no money binding and no D1", () => {
  const config = jsonc(read("mcp/wrangler.jsonc"));

  it("is its own Worker on admin-mcp.foxhoundapp.com", () => {
    expect(config.name).toBe("foxhound-admin-mcp");
    expect(config.routes).toEqual([{ pattern: "admin-mcp.foxhoundapp.com", custom_domain: true }]);
  });

  it("binds only the foxhound service and the OAuth KV, nothing else", () => {
    expect(config.services).toEqual([{ binding: "FOXHOUND", service: "foxhound" }]);
    expect((config.kv_namespaces as { binding: string }[]).map((k) => k.binding)).toEqual(["OAUTH_KV"]);
    for (const forbidden of ["d1_databases", "r2_buckets", "queues", "durable_objects", "send_email", "analytics_engine_datasets", "hyperdrive"]) {
      expect(config[forbidden], forbidden).toBeUndefined();
    }
    expect(JSON.stringify(config.vars ?? {})).not.toMatch(/stripe/i);
  });

  it("no source file under mcp/src reaches the app, the ORM, Stripe or a money writer", () => {
    const dir = fileURLToPath(new URL("mcp/src/", ROOT));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const body = strip(read(`mcp/src/${file}`));
      for (const forbidden of ['from "~/', "../app", "../../app", "drizzle", "stripe", "STRIPE", "executeMoneyWrite", "D1Database"]) {
        expect(body, `${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("PLANT 2: the nine tools", () => {
  it("are exactly the ruling's nine, foxhound_admin_ named, with all four hints", () => {
    expect([...ADMIN_TOOL_NAMES].sort()).toEqual(
      [
        "foxhound_admin_whats_next",
        "foxhound_admin_get_platform",
        "foxhound_admin_find_merchant",
        "foxhound_admin_read_merchant_data",
        "foxhound_admin_check_health",
        "foxhound_admin_read_audit_log",
        "foxhound_admin_pause",
        "foxhound_admin_stage_change",
        "foxhound_admin_list_staged",
      ].sort(),
    );
    for (const tool of ADMIN_TOOLS) {
      // The service prefix and at least one word; the ruling names pause on its own.
      expect(tool.name).toMatch(/^foxhound_admin(_[a-z]+)+$/);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations[hint], `${tool.name} ${hint}`).toBe("boolean");
      }
      expect(tool.name).not.toMatch(/refund|adjust|cancel|disconnect|charge|resume/);
    }
  });

  it("only pause and stage_change write; every other tool is read-only", () => {
    const writes = ADMIN_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(["foxhound_admin_pause", "foxhound_admin_stage_change"]);
  });

  it("every call carries the admin key and the signed-in admin's email", async () => {
    const fox = fakeFoxhound();
    await callTool(fox.binding, "foxhound_admin_get_platform", {});
    expect(fox.calls).toHaveLength(1);
    expect(fox.calls[0]).toMatchObject({ method: "GET", path: "/api/admin/v1/platform", auth: `Bearer ${KEY}`, actor: ADMIN });
  });

  it("each tool maps to its API route", async () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ["foxhound_admin_whats_next", {}, "GET", "/api/admin/v1/whats-next"],
      ["foxhound_admin_find_merchant", { query: "beta" }, "GET", "/api/admin/v1/merchants"],
      ["foxhound_admin_find_merchant", { account_id: "acct_a" }, "GET", "/api/admin/v1/merchants/acct_a"],
      ["foxhound_admin_read_merchant_data", { account_id: "acct_a" }, "GET", "/api/admin/v1/merchants/acct_a/data"],
      ["foxhound_admin_check_health", {}, "GET", "/api/admin/v1/health"],
      ["foxhound_admin_read_audit_log", {}, "GET", "/api/admin/v1/audit-log"],
      ["foxhound_admin_list_staged", {}, "GET", "/api/admin/v1/staged"],
      ["foxhound_admin_pause", { account_id: "acct_a" }, "POST", "/api/admin/v1/pause"],
      ["foxhound_admin_stage_change", { kind: "resume_account", account_id: "acct_a" }, "POST", "/api/admin/v1/staged"],
    ];
    for (const [tool, args, method, path] of cases) {
      const fox = fakeFoxhound();
      const out = await callTool(fox.binding, tool, args);
      expect(out.isError, `${tool}: ${JSON.stringify(out.data)}`).toBe(false);
      expect([fox.calls[0]?.method, fox.calls[0]?.path], tool).toEqual([method, path]);
    }
  });

  it("an id is encoded into the path, so it cannot reach another route", async () => {
    const fox = fakeFoxhound();
    await callTool(fox.binding, "foxhound_admin_find_merchant", { account_id: "../pause" });
    expect(fox.calls[0].path).toBe("/api/admin/v1/merchants/..%2Fpause");
  });

  it("the API's refusal reaches the agent as a tool error with the API's own sentence", async () => {
    const fox = fakeFoxhound(() => ({ status: 400, body: { ok: false, error: "No merchant acct_x. Find one with the merchants read." } }));
    const out = await callTool(fox.binding, "foxhound_admin_pause", { account_id: "acct_x" });
    expect(out.isError).toBe(true);
    expect(out.data.error).toBe("No merchant acct_x. Find one with the merchants read.");
  });

  it("stage_change says nothing has changed yet, and pause all needs an explicit all: true", async () => {
    const fox = fakeFoxhound();
    const stage = await callTool(fox.binding, "foxhound_admin_stage_change", { kind: "release_brake" });
    expect(JSON.stringify(stage.data)).toMatch(/\/admin\/staged/);
    const nothing = await callTool(fakeFoxhound().binding, "foxhound_admin_pause", {});
    expect(nothing.isError).toBe(true);
  });
});

describe("PLANT 3: least scope (rule 12.3)", () => {
  it("a read-only grant can read and cannot pause or stage", async () => {
    const fox = fakeFoxhound();
    expect((await callTool(fox.binding, "foxhound_admin_get_platform", {}, [SCOPE_READ])).isError).toBe(false);
    for (const tool of ["foxhound_admin_pause", "foxhound_admin_stage_change"]) {
      const out = await callTool(fox.binding, tool, { account_id: "acct_a", kind: "resume_account" }, [SCOPE_READ]);
      expect(out.isError, tool).toBe(true);
      expect(String(out.data.error)).toMatch(/read-only/);
    }
    expect(fox.calls.map((c) => c.path)).toEqual(["/api/admin/v1/platform"]);
  });

  it("write is granted only when asked for and not narrowed at consent", () => {
    expect(grantScopes([])).toEqual([SCOPE_READ]);
    expect(grantScopes([SCOPE_READ, SCOPE_WRITE])).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(grantScopes([SCOPE_READ, SCOPE_WRITE], { readOnly: true })).toEqual([SCOPE_READ]);
    expect(grantScopes(["admin:everything"])).toEqual([SCOPE_READ]);
  });
});

describe("PLANT 4: the door (rule 12.2)", () => {
  const origin = "https://admin-mcp.foxhoundapp.com";
  const good = { audience: `${origin}/mcp`, props: { email: ADMIN, client: "c", clientId: "https://claude.ai/x" }, scope: [SCOPE_READ] };

  it("a token issued for another resource is refused", () => {
    expect(guardMcpRequest(origin, { ...good, audience: "https://carrel-mcp.dustinedwards.info/mcp" }).ok).toBe(false);
    expect(guardMcpRequest(origin, { ...good, audience: undefined }).ok).toBe(false);
    expect(guardMcpRequest(origin, good).ok).toBe(true);
  });

  it("a grant with no email is refused", () => {
    expect(guardMcpRequest(origin, { ...good, props: { client: "c" } }).ok).toBe(false);
  });

  it("whether someone is a Foxhound admin is the API's answer, asked at sign-in", async () => {
    const fox = fakeFoxhound((call) =>
      call.actor === ADMIN ? { status: 200, body: { ok: true, data: { actor: ADMIN } } } : { status: 403, body: { ok: false, error: "no" } },
    );
    expect(await isFoxhoundAdmin(env(fox.binding), ADMIN)).toBe(true);
    expect(await isFoxhoundAdmin(env(fox.binding), "intruder@foxhound.test")).toBe(false);
    expect(fox.calls.map((c) => c.path)).toEqual(["/api/admin/v1/me", "/api/admin/v1/me"]);
  });
});

describe("PLANT 5: tightened registration (rule 13)", () => {
  const allowed = new Set(DCR_REDIRECT_URIS);

  it("accepts only the exact callbacks of the AI apps on the list", () => {
    expect(checkRegistration(allowed, { redirect_uris: ["https://grok.com/connectors/oauth/callback"] })).toBeUndefined();
    for (const uris of [
      ["https://evil.test/callback"],
      ["https://grok.com/connectors/oauth/callback/../../evil"],
      ["http://localhost:8080/callback"],
      [],
      "https://grok.com/connectors/oauth/callback",
    ]) {
      expect(checkRegistration(allowed, { redirect_uris: uris }), JSON.stringify(uris)).toBeDefined();
    }
  });

  it("is rate limited per address", async () => {
    const store = new Map<string, string>();
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
    const request = new Request("https://admin-mcp.foxhoundapp.com/register", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } });
    const results: (Response | null)[] = [];
    for (let i = 0; i < 6; i += 1) results.push(await registrationLimited(request, { OAUTH_KV: kv } as never, 0));
    expect(results.slice(0, 5).every((r) => r === null)).toBe(true);
    expect(results[5]?.status).toBe(429);
  });
});

describe("PLANT 6: the exception is on record", () => {
  it("Foxhound's CLAUDE.md names the admin MCP as the one exception to the single Worker rule", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toMatch(/foxhound-admin-mcp/);
    expect(claude).toMatch(/admin-mcp\.foxhoundapp\.com/);
    expect(claude).toMatch(/one exception/i);
  });
});
