// A small MCP client for the /mcp tests: builds a request in either protocol
// era and reads the answer back whether the SDK sent JSON or an SSE stream.
//
// LEGACY (2025-era) is what Claude Code and claude.ai speak today: no
// MCP-Protocol-Version header, and the SDK's stateless fallback answers a
// request with one SSE `message` event. MODERN (2026-07-28) carries the version
// header, Mcp-Method and Mcp-Name, and the version and client info in `_meta`,
// and is answered with a JSON body.

const MODERN_VERSION = "2026-07-28";
const TEST_ORIGIN = "https://foxhoundapp.test";

export interface McpCallInit {
  token?: string | null;
  method?: string;
  params?: Record<string, unknown>;
  /** A JSON-RPC id. null sends a notification. Defaults to 1. */
  id?: number | null;
  era?: "legacy" | "modern";
  headers?: Record<string, string>;
  /** A raw body, sent as-is in place of the built envelope. */
  body?: string;
  httpMethod?: string;
}

export function mcpRequest(init: McpCallInit = {}): Request {
  const method = init.method ?? "tools/list";
  const era = init.era ?? "legacy";
  const params: Record<string, unknown> = { ...(init.params ?? {}) };
  if (era === "modern") {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientInfo": { name: "foxhound-test", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
      ...((params._meta as Record<string, unknown> | undefined) ?? {}),
    };
  }
  const envelope: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (init.id !== null) envelope.id = init.id ?? 1;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (era === "modern") {
    headers["MCP-Protocol-Version"] = MODERN_VERSION;
    headers["Mcp-Method"] = method;
    const name = (init.params ?? {}).name;
    if (typeof name === "string") headers["Mcp-Name"] = name;
  }
  Object.assign(headers, init.headers ?? {});

  const httpMethod = init.httpMethod ?? "POST";
  return new Request(`${TEST_ORIGIN}/mcp`, {
    method: httpMethod,
    headers,
    body: httpMethod === "GET" || httpMethod === "DELETE" ? undefined : (init.body ?? JSON.stringify(envelope)),
  });
}

export interface McpAnswer {
  status: number;
  /** The JSON-RPC message as text: the body itself, or the SSE event's data. */
  text: string;
  json: unknown;
  res: Response;
}

export async function readMcp(res: Response): Promise<McpAnswer> {
  const raw = await res.clone().text();
  let text = raw;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    text = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
  }
  return { status: res.status, text, json: text ? JSON.parse(text) : null, res };
}

/** The structured result of a tools/call, or the tool error it carried. */
export function toolOutput(answer: McpAnswer): { isError: boolean; data: Record<string, unknown> } {
  const result = (answer.json as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } })
    .result;
  if (!result) throw new Error(`not a tool result: ${answer.text}`);
  return { isError: result.isError === true, data: result.structuredContent ?? {} };
}

/** A TOOL_CALL_LOG binding that accepts every row, for tests that are not about the log.
 *  The door refuses a call whose `started` row cannot be written, so every /mcp test needs one. */
export function toolCallLogStub() {
  return {
    idFromName: () => "tool-calls",
    get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
  };
}
