import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, confirmedCall, TEST_LINK_KEY } from "./helpers/mcp-client";

// RULE 12.4 OF THE 2026-10-10 MCP RULING: an append-only log of every tool
// call, with the caller, the arguments and the result.
//
// "EVERY" IS THE WORD THESE PLANTS HOLD. A read, a write, a call the tool
// refused, a call the SDK refused at its schema check and a call naming a tool
// that does not exist each leave one row, because the log is written at the
// door from the request and the response rather than inside a tool, where only
// the calls that reached a tool would be seen.
//
// APPEND-ONLY IS A DATABASE FACT, not a convention: the migration installs
// triggers that abort any UPDATE or DELETE on the table, so no code path, this
// one included, can rewrite what a key did.
//
// WHAT IS NOT KEPT: the Slack webhook URL an agent sends (a credential for the
// merchant's Slack) is stored as "[redacted]", and an email address inside a
// stored error is masked the way the endpoint masks one on the wire. The result
// is kept as its outcome and error text, never the data a read returned, so
// the log does not become a second copy of the merchant's customers.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");

const MINE = "acct_mine";
const NOW = new Date("2026-10-10T12:00:00.000Z");

/** The rows sent to TOOL_CALL_LOG, site-runtime's ToolCallLog beside mcp_calls. */
const auditRows: Record<string, unknown>[] = [];

function env(): Env {
  return {
    DB: {},
    EMAIL_TOKEN_KEY: TEST_LINK_KEY,
    TOOL_CALL_LOG: {
      idFromName: () => "tool-calls",
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          auditRows.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 204 });
        },
      }),
    },
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

async function seed() {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: MINE, name: MINE, createdAt: NOW, currency: "usd" });
  const token = `${MCP_TOKEN_PREFIX}${MINE}`;
  await db.insert(apiKeys).values({
    id: `key_${MINE}`,
    accountId: MINE,
    keyHash: await hashMcpToken(token),
    label: "agent",
    scope: MCP_TOKEN_SCOPE.MERCHANT,
    // A key that may change the account, as one made in Settings.
    scopes: ["merchant.read", "merchant.write"],
    createdAt: NOW,
  });
  await db.insert(stripeConnections).values({
    id: `sc_${MINE}`,
    accountId: MINE,
    stripeUserId: `acct_stripe_${MINE}`,
    stripeAccessToken: "enc",
    isPrimary: true,
    connectedAt: NOW,
    createdAt: NOW,
  });
  return { sqlite, token };
}

async function callTool(token: string | null, name: string, args: unknown) {
  const res = (await confirmedCall((a) => handleMcpRequest(mcpRequest({ token, method: "tools/call", params: { name, arguments: a } }), env(), MERCHANT_TOOLS), args as Record<string, unknown>));
  return readMcp(res);
}

interface LogRow {
  account_id: string;
  api_key_id: string;
  tool: string;
  arguments: string;
  outcome: string;
  error: string | null;
  created_at: number;
}

function logRows(sqlite: ReturnType<typeof createInMemoryDb>["sqlite"]): LogRow[] {
  return sqlite.prepare("SELECT * FROM mcp_calls ORDER BY rowid").all() as LogRow[];
}

// ============================================================================

describe("PLANT 1: every tool call leaves one row", () => {

  it("a call the tool refused is logged as tool_error with the refusal", async () => {
    const { sqlite, token } = await seed();
    await callTool(token, "foxhound_get_payment", { payment_id: "fp_nope" });
    const [row] = logRows(sqlite);
    expect(row.outcome).toBe("tool_error");
    expect(row.error).toContain("fp_nope");
  });

  it("a call the SDK refused at its schema check is logged, so the log is not only what reached a tool", async () => {
    const { sqlite, token } = await seed();
    await callTool(token, "foxhound_manage_alerts", { action: "explode" });
    const [row] = logRows(sqlite);
    expect(row.tool).toBe("foxhound_manage_alerts");
    expect(row.outcome).toBe("tool_error");
    expect(row.error).toMatch(/action/);
  });

  it("a call naming a tool that does not exist is logged as protocol_error", async () => {
    const { sqlite, token } = await seed();
    await callTool(token, "foxhound_refund_everything", {});
    const [row] = logRows(sqlite);
    expect(row.tool).toBe("foxhound_refund_everything");
    expect(row.outcome).toBe("protocol_error");
  });

  it("tools/list is not a tool call and an unauthenticated call has no caller, so neither is logged", async () => {
    const { sqlite, token } = await seed();
    await handleMcpRequest(mcpRequest({ token, method: "tools/list" }), env(), MERCHANT_TOOLS);
    const refused = await callTool(null, "foxhound_get_overview", {});
    expect(refused.status).toBe(401);
    expect(logRows(sqlite)).toEqual([]);
  });
});

describe("PLANT 2: what the log never keeps", () => {
  it("the Slack webhook URL is stored as [redacted], and the setting itself still lands", async () => {
    const { sqlite, token } = await seed();
    auditRows.length = 0;
    const url = "https://hooks.slack.com/services/T0LOG/B0LOG/logPangolinSecret";
    await callTool(token, "foxhound_update_settings", { notifications: { slack_webhook_url: url } });
    const [row] = logRows(sqlite);
    expect(row.outcome).toBe("ok");
    expect(row.arguments).not.toContain("logPangolinSecret");
    expect(JSON.parse(row.arguments)).toEqual({ notifications: { slack_webhook_url: "[redacted]" } });
    // The shared log gets a started row before the call and a finished row
    // after, one call id between them, both redacted the same way.
    // The call is made twice, the second time with the confirm code
    // (app/lib/mcp/confirm.server.ts), which is stored as [redacted] too.
    expect(auditRows.map((r) => r.phase)).toEqual(["started", "finished", "started", "finished"]);
    expect(auditRows[3]).toMatchObject({ tool: "foxhound_update_settings", result: { isError: false, text: "ok" } });
    expect(auditRows[3].callId).toBe(auditRows[2].callId);
    expect(JSON.parse(logRows(sqlite)[1].arguments).confirm).toBe("[redacted]");
    expect(JSON.stringify(auditRows)).not.toContain("logPangolinSecret");
    const stored = sqlite.prepare("SELECT slack_webhook_url FROM accounts WHERE id = ?").get(MINE) as {
      slack_webhook_url: string;
    };
    expect(stored.slack_webhook_url).toBe(url);
  });

  it("an email address inside a stored error is masked", async () => {
    const { sqlite, token } = await seed();
    await callTool(token, "foxhound_get_customer", { stripe_customer_id: "wanda.lowell@example.test" });
    const [row] = logRows(sqlite);
    expect(row.outcome).toBe("tool_error");
    expect(row.error).not.toContain("wanda.lowell@example.test");
    expect(row.error).toContain("w***@example.test");
  });
});

describe("PLANT 4: a call that cannot be logged is not run", () => {
  it("when the started row cannot be written the request is refused and the setting is untouched", async () => {
    const { sqlite, token } = await seed();
    const broken = {
      ...env(),
      TOOL_CALL_LOG: { idFromName: () => "tool-calls", get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
    } as unknown as Env;
    const res = (await handleMcpRequest(
      mcpRequest({
        token,
        method: "tools/call",
        params: { name: "foxhound_update_settings", arguments: { features: { winback_notifications_enabled: false, expiring_card_notifications_enabled: false } } },
      }),
      broken,
      MERCHANT_TOOLS,
    )) as Response;
    expect(res.status).toBe(503);
    expect(logRows(sqlite)).toEqual([]);
    const account = sqlite.prepare("SELECT winback_notifications_enabled AS w FROM accounts WHERE id = ?").get(MINE) as { w: number };
    expect(account.w).not.toBe(0);
  });
});

describe("PLANT 3: append-only in the database itself", () => {
  it("UPDATE and DELETE on mcp_calls are aborted by the schema", async () => {
    const { sqlite, token } = await seed();
    await callTool(token, "foxhound_get_overview", {});
    expect(logRows(sqlite)).toHaveLength(1);
    expect(() => sqlite.prepare("UPDATE mcp_calls SET tool = 'rewritten'").run()).toThrow(/append-only/);
    expect(() => sqlite.prepare("DELETE FROM mcp_calls").run()).toThrow(/append-only/);
    // Both refusals left the row as it was, so the triggers are the guard.
    expect(logRows(sqlite).map((r) => r.tool)).toEqual(["foxhound_get_overview"]);
  });
});
