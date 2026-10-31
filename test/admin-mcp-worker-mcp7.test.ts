import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCOPE_READ, SCOPE_WRITE } from "../mcp/src/scopes";
import { ADMIN_TOOLS, ADMIN_TOOL_NAMES } from "../mcp/src/tools";
import { serveAdminMcp } from "../mcp/src/server";
import { isFoxhoundAdmin } from "../mcp/src/guard";

import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// JOB job_21de68b30fc2, PR 2: THE FOXHOUND ADMIN MCP, its own Worker at
// admin-mcp.foxhoundapp.com (MCP ruling 2026-10-10, rule 9 amendment).
//
// THE WORKER HOLDS NOTHING THAT MOVES MONEY. No Stripe key, no money binding,
// no D1. Its one way into Foxhound is the admin API (PR 1) over a service
// binding, carrying the admin key and the signed-in admin's email on every
// call, and that API re-checks the admin and offers only reads, pause and
// staging. These plants hold the Worker to that shape, the nine tools to the
// ruling, and the door to rule 12. The consent scope and the registration rules
// (rule 13) are site-runtime's mcp-login, tested there.

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
const KEY = "fox_mcp_test_admin_key_at_least_32_chars";

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
      // callApi hands a service binding a URL and init, as Fetcher.fetch takes them.
      async fetch(input: Request | string, init?: RequestInit) {
        const request = new Request(input, init);
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

/** A fake TOOL_CALL_LOG that keeps the rows it is sent. */
function toolCallLog(rows: Record<string, unknown>[] = []) {
  const stub = {
    fetch: async (_url: string, init: RequestInit) => {
      rows.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    },
  };
  return { idFromName: () => "tool-calls", get: () => stub };
}

function env(binding: { fetch(request: Request): Promise<Response> }, rows?: Record<string, unknown>[]) {
  return { FOXHOUND: binding, FOXHOUND_ADMIN_API_KEY: KEY, TOOL_CALL_LOG: toolCallLog(rows) } as never;
}

async function callTool(
  binding: { fetch(request: Request): Promise<Response> },
  name: string,
  args: Record<string, unknown>,
  scopes: string[] = [SCOPE_READ, SCOPE_WRITE],
  rows?: Record<string, unknown>[],
) {
  const res = await serveAdminMcp(mcpRequest({ method: "tools/call", params: { name, arguments: args } }), env(binding, rows), {
    actor: ADMIN,
    client: "test client",
    scopes,
  });
  const answer = await readMcp(res);
  // The refusal's sentence: a refused call carries no structuredContent.
  const text = (answer.json as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? "";
  return { ...toolOutput(answer), text };
}

// ============================================================================

describe("PLANT 1: the Worker holds no Stripe key, no money binding and no D1", () => {
  const config = jsonc(read("mcp/wrangler.jsonc"));

  it("binds only the foxhound service, the OAuth KV and its own limiter and log, nothing else", () => {
    expect(config.services).toEqual([{ binding: "FOXHOUND", service: "foxhound", entrypoint: "AdminApi" }]);
    expect((config.kv_namespaces as { binding: string }[]).map((k) => k.binding)).toEqual(["OAUTH_KV"]);
    // Its own classes only: no script_name, so never one of the foxhound Worker's money objects.
    expect((config.durable_objects as { bindings: unknown[] }).bindings).toEqual([
      { name: "MCP_RATE_LIMIT", class_name: "RateLimiter" },
      { name: "TOOL_CALL_LOG", class_name: "ToolCallLog" },
    ]);
    for (const forbidden of ["d1_databases", "r2_buckets", "queues", "send_email", "analytics_engine_datasets", "hyperdrive"]) {
      expect(config[forbidden], forbidden).toBeUndefined();
    }
    expect(JSON.stringify(config.vars ?? {})).not.toMatch(/stripe/i);
  });
});

describe("PLANT 2: the tools", () => {
  // The ruling's nine, plus the owner's test mail (preview and send), which
  // Dustin approved on 2026-10-15 (cmsg_01Nd8kh3hkgYNYpWXrNkvBQLJoLik1xYvr9pCLcgZ3SSMJ).
  // test/admin-email-send-preview.test.ts holds those two to their own rules.
  it("are exactly the ruling's nine and the two test-mail tools, foxhound_admin_ named, with all four hints", () => {
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
        "foxhound_admin_preview_email",
        "foxhound_admin_send_test_email",
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

  it("only pause, stage_change and the test-mail send need the write scope, and their hints say so", () => {
    const writes = ADMIN_TOOLS.filter((t) => t.scope === "write").map((t) => t.name).sort();
    expect(writes).toEqual(["foxhound_admin_pause", "foxhound_admin_send_test_email", "foxhound_admin_stage_change"]);
    for (const tool of ADMIN_TOOLS) expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.scope === "read");
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

describe("PLANT 3: least scope (rule 12.3) and the tool-call log (rule 12.4)", () => {
  it("a read-only grant can read and cannot pause or stage, and every call is a row", async () => {
    const fox = fakeFoxhound();
    const rows: Record<string, unknown>[] = [];
    expect((await callTool(fox.binding, "foxhound_admin_get_platform", {}, [SCOPE_READ], rows)).isError).toBe(false);
    for (const tool of ["foxhound_admin_pause", "foxhound_admin_stage_change"]) {
      const out = await callTool(fox.binding, tool, { account_id: "acct_a", kind: "resume_account" }, [SCOPE_READ], rows);
      expect(out.isError, tool).toBe(true);
      expect(out.text).toMatch(/read access only/);
    }
    expect(fox.calls.map((c) => c.path)).toEqual(["/api/admin/v1/platform"]);
    // The refusals reach the log too, which a console line never did.
    expect(rows.map((r) => [r.phase, r.tool])).toEqual([
      ["started", "foxhound_admin_get_platform"],
      ["finished", "foxhound_admin_get_platform"],
      ["refused", "foxhound_admin_pause"],
      ["refused", "foxhound_admin_stage_change"],
    ]);
  });
});

describe("PLANT 4: the door", () => {
  it("whether someone is a Foxhound admin is the API's answer, asked at sign-in", async () => {
    const fox = fakeFoxhound((call) =>
      call.actor === ADMIN ? { status: 200, body: { ok: true, data: { actor: ADMIN } } } : { status: 403, body: { ok: false, error: "no" } },
    );
    expect(await isFoxhoundAdmin(env(fox.binding), ADMIN)).toBe(true);
    expect(await isFoxhoundAdmin(env(fox.binding), "intruder@foxhound.test")).toBe(false);
    expect(fox.calls.map((c) => c.path)).toEqual(["/api/admin/v1/me", "/api/admin/v1/me"]);
  });
});
