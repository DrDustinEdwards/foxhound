import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { defineToolRegistry, ToolInputError, type McpTool } from "~/lib/mcp/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput, toolCallLogStub } from "./helpers/mcp-client";

// A tool's error text is masked like its result: a ToolInputError goes out with emails masked; any
// other failure's message stays on the server and the agent is told to retry.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { sha256Hex } = await import("@dustinedwards/site-runtime/encoding");

const MINE = "acct_mine";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const NAME = "Ottoline Brackenbury";
const EMAIL = "ottoline.brackenbury@example.test";

function env(): Env {
  return {
    DB: {},
    TOOL_CALL_LOG: toolCallLogStub(),
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

function throwing(name: string, error: () => Error): McpTool {
  return {
    name,
    title: "t",
    description: "d",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    scope: "read",
    execute: async () => {
      throw error();
    },
  };
}

const REGISTRY = defineToolRegistry([
  throwing(
    "foxhound_get_crash",
    () => new Error(`SQLITE_CONSTRAINT: customer_name='${NAME}' email='${EMAIL}'`),
  ),
  throwing(
    "foxhound_get_refusal",
    () => new ToolInputError(`No customer ${EMAIL} on this account.`),
  ),
]);

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: MINE, name: MINE, createdAt: NOW, currency: "usd" });
  const token = `${MCP_TOKEN_PREFIX}${MINE}`;
  await db.insert(apiKeys).values({
    id: `key_${MINE}`,
    accountId: MINE,
    keyHash: await sha256Hex(token),
    label: "agent",
    scope: MCP_TOKEN_SCOPE.MERCHANT,
    createdAt: NOW,
  });
  return token;
}

async function call(token: string, name: string) {
  const res = (await handleMcpRequest(
    mcpRequest({ token, method: "tools/call", params: { name, arguments: {} } }),
    env(),
    REGISTRY,
  )) as Response;
  return readMcp(res);
}

describe("tool errors are masked before they reach the agent", () => {
  it("an unexpected failure's message never leaves the server: no name, no email, a retry sentence", async () => {
    const token = await seed();
    const debug = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await call(token, "foxhound_get_crash");
    const { isError, data } = toolOutput(answer);
    expect(isError).toBe(true);
    expect(answer.text).not.toContain("Ottoline");
    expect(answer.text).not.toContain(EMAIL);
    expect(answer.text).not.toContain("SQLITE");
    expect(String(data.error)).toMatch(/try again/i);
    // The real message is not lost: it goes to the server log.
    expect(debug.mock.calls.flat().join(" ")).toContain("SQLITE_CONSTRAINT");
    debug.mockRestore();
  });
});
