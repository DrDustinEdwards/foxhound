import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { defineToolRegistry, ToolInputError, type McpTool } from "~/lib/mcp/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// A TOOL'S ERROR TEXT GOES THROUGH THE SAME MASKING AS ITS RESULT.
//
// The redactor walks a tool's RETURN VALUE, and until now a thrown error took
// a different road: its message went on the wire as written. Two kinds of
// error, two treatments:
//
//   - A REFUSAL (ToolInputError) is a sentence Foxhound wrote to tell the agent
//     how to fix its input. It goes out, with any email address in it masked:
//     it can echo the agent's own input, and that input can be an address.
//   - ANYTHING ELSE is a failure nobody wrote for an agent: a database error can
//     carry the values of the query it failed on, a customer's name or email
//     among them. Its message never leaves the server. The agent is told the
//     call failed and that it can try again, and the real message goes to the
//     server log.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");

const MINE = "acct_mine";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const NAME = "Ottoline Brackenbury";
const EMAIL = "ottoline.brackenbury@example.test";

function env(): Env {
  return {
    DB: {},
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
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async () => {
      throw error();
    },
  };
}

const REGISTRY = defineToolRegistry([
  throwing("foxhound_get_crash", () => new Error(`SQLITE_CONSTRAINT: customer_name='${NAME}' email='${EMAIL}'`)),
  throwing("foxhound_get_refusal", () => new ToolInputError(`No customer ${EMAIL} on this account.`)),
]);

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: MINE, name: MINE, createdAt: NOW, currency: "usd" });
  const token = `${MCP_TOKEN_PREFIX}${MINE}`;
  await db.insert(apiKeys).values({
    id: `key_${MINE}`,
    accountId: MINE,
    keyHash: await hashMcpToken(token),
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
