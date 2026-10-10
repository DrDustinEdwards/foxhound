import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";

import type { McpToolContext, McpToolRegistry } from "./registry";

// THE PROTOCOL, FROM THE OFFICIAL SDK (MCP ruling rule 8, 2026-10-10).
//
// The hand-written JSON-RPC that served /mcp until now is replaced by
// @modelcontextprotocol/server 2.0, the same SDK Carrel runs. Only the server
// package is used, not Cloudflare's `agents` wrapper: the server package ships
// its own web-standard `createMcpHandler`, so the money Worker gains two small
// packages (server and core) and no tree re-resolution. That was the measured
// objection to `agents` when /mcp was first built, and it does not apply here.
//
// STATELESS BOTH WAYS. The 2026-07-28 revision has no sessions, and the
// 2025-era clients that still open with `initialize` (Claude Code and
// claude.ai, as last measured) are served by the SDK's stateless fallback:
// each request gets a fresh server from the factory below and nothing outlives
// it. `server/discover`, the header and body agreement checks and the -32020
// mismatch answer are the SDK's, not Foxhound's.
//
// THE SDK SPEAKS ONLY THE PROTOCOL. Who is calling, which account they act for
// and whether they may call at all are settled by ./handler.server.ts before a
// request reaches this file, and the account is closed over here, never read
// from the request.

export const MCP_SERVER_INFO = { name: "foxhound", title: "Foxhound", version: "2.0.0" } as const;

const INSTRUCTIONS = [
  "Foxhound recovers failed Stripe payments and tracks disputes and subscription health for one merchant: the account this key belongs to, and no other.",
  "Every tool reads or changes that account only. Ids come from the list tools. Nothing here moves money, submits a dispute, issues a refund, or connects or disconnects Stripe; those stay in the Foxhound app.",
  "Customer names are never returned and emails are masked.",
].join(" ");

/** The tool list never changes within a deploy, so a client may cache it for an
 *  hour. Private: it is served to an authenticated caller. */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 3_600_000, cacheScope: "private" },
  "server/discover": { ttlMs: 3_600_000, cacheScope: "private" },
} as const;

/** What a tool execution returns on the wire. A failed tool comes back inside
 *  the result with `isError`, so the agent sees why and can correct the input;
 *  JSON-RPC errors are reserved for protocol failures. */
function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: (data ?? {}) as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * One server for one request, with every registered tool on it in registry
 * order, so `tools/list` is deterministic.
 */
export function buildMcpServer(registry: McpToolRegistry, ctx: McpToolContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS, cacheHints: CACHE_HINTS });
  for (const descriptor of registry.list()) {
    const tool = registry.get(descriptor.name);
    if (!tool) continue;
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: fromJsonSchema(descriptor.inputSchema as JsonSchemaType),
        annotations: descriptor.annotations,
      },
      async (args: unknown) => {
        try {
          // THE TRACE NAMES THE TOOL BEING RUN, set here rather than passed in,
          // so a tool cannot record a different tool's name against its write.
          const data = await tool.execute(
            { ...ctx, trace: { ...ctx.trace, tool: descriptor.name } },
            (args ?? {}) as Record<string, unknown>,
          );
          return toolResult(data);
        } catch (err) {
          // A HELPER FAILURE NEVER THROWS THROUGH THE TRANSPORT. The message is
          // the error's own text and never the object, which can carry query
          // context.
          const reason = err instanceof Error ? err.message : "unknown error";
          console.debug("mcp tool failed:", descriptor.name, reason);
          return toolResult({ error: reason, tool: descriptor.name }, true);
        }
      },
    );
  }
  return server;
}

/** Serve one already-authenticated request through the SDK. */
export function serveMcp(request: Request, registry: McpToolRegistry, ctx: McpToolContext) {
  // `responseMode` stays the SDK's "auto": one JSON body per modern answer,
  // because no tool here emits a message before its result.
  const handler = createMcpHandler(() => buildMcpServer(registry, ctx), { legacy: "stateless" });
  return handler.fetch(request);
}
