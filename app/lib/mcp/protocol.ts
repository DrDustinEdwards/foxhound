// The MCP wire protocol, hand-rolled and PURE. No transport, no database, no
// network: this module decides what a well-formed request is and what shape an
// answer takes, so every rule below is testable without a Worker.
//
// WHY HAND-ROLLED, AND THE MEASUREMENT THAT DECIDED IT (session 76, Dustin
// ratified). 370's design named Cloudflare's `createMcpHandler`. Installing
// `agents@0.21.0` forces npm to re-resolve the whole tree, which surfaces a
// PRE-EXISTING latent conflict: `@sentry/cloudflare@10.65.0` declares
// `peerOptional @cloudflare/workers-types@^4.x` and the tree carries
// `5.20260825.1`. A plain `npm install` on the current tree is clean, so the
// conflict is latent rather than active, and `agents` exposes it rather than
// causing it. Resolving it needs `--legacy-peer-deps` or an `overrides` pin,
// both of which change dependency resolution tree-wide on a repo that moves
// money. The spec's modern era is small enough to write, so it is written.
//
// WHAT THAT COSTS, STATED HONESTLY: spec conformance is now Foxhound's to
// maintain rather than a library's, and the two eras below are hand-written
// rather than inherited. What it buys: no new dependency in the money Worker, no
// tree re-resolution, no bundle growth, and the Sentry peer mismatch stays
// latent instead of being force-resolved by a session that was not looking at
// it.
//
// SPEC REVISION 2026-07-28, read at build time, not recalled. The rules encoded
// here, each with the clause that requires it:
//
//   - "The server MUST provide a single HTTP endpoint path ... that supports
//     POST." GET and DELETE get 405 (Backward Compatibility, Earlier Revisions).
//   - "Every POST request to the MCP endpoint MUST include an
//     `MCP-Protocol-Version` header", and its value "MUST match the
//     `io.modelcontextprotocol/protocolVersion` field carried in the request
//     body's `_meta`". A mismatch is 400 with code -32020 HeaderMismatch.
//   - `Mcp-Method` is REQUIRED on all requests; `Mcp-Name` on tools/call.
//   - "If the server does not implement the requested RPC method, it MUST
//     respond with 404 Not Found and a JSON-RPC error with code -32601."
//   - A notification body gets 202 Accepted with no body.
//   - Protocol-level SESSIONS ARE GONE in this revision, which is what lets this
//     endpoint be stateless and is why there is no Durable Object anywhere here.
//
// THE LEGACY ERA IS SERVED TOO, on the same path, because a modern-only
// endpoint would be conformant and unusable: the clients that exist today
// mostly speak an earlier revision, which opens with an `initialize` handshake
// and sends no `MCP-Protocol-Version` header. The spec's own Backward
// Compatibility section describes exactly this detection, and Cloudflare's
// handler does the same thing ("The same route serves MCP 2026-07-28 clients and
// legacy clients that use stateless requests"). Era is decided by the header's
// presence and nothing else.

/** The revision this server implements natively. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Revisions a legacy-era client may ask for and still be served. The 2025-03-26
 *  floor is the spec's own: it is the version a server "MAY treat a request that
 *  omits the header as". */
export const MCP_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const MCP_SERVER_INFO = { name: "foxhound", version: "1.0.0" } as const;

/** JSON-RPC and MCP error codes used here. -32020 is allocated by the MCP spec
 *  from its reserved protocol range; the rest are JSON-RPC's own. */
export const MCP_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
} as const;

export type McpEra = "modern" | "legacy";

export interface McpRequestBody {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** A refusal carries the HTTP status the spec assigns AND the JSON-RPC code, so
 *  a caller cannot pair the wrong two (339 binding 5: a discriminated outcome,
 *  never a bare boolean). */
export interface McpRefusal {
  status: number;
  code: number;
  message: string;
}

export type McpValidation =
  | { ok: true; era: McpEra; body: McpRequestBody; isNotification: boolean }
  | { ok: false; refusal: McpRefusal };

function refuse(status: number, code: number, message: string): McpValidation {
  return { ok: false, refusal: { status, code, message } };
}

/** The `_meta` protocol version a modern body carries. */
function metaProtocolVersion(body: McpRequestBody): string | null {
  const meta = body.params?.["_meta"];
  if (!meta || typeof meta !== "object") return null;
  const value = (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
  return typeof value === "string" ? value : null;
}

/**
 * Validate one POST body against its headers.
 *
 * ERA IS THE HEADER'S PRESENCE, and nothing else. A request carrying
 * `MCP-Protocol-Version` is held to the modern rules in full: the header must
 * name a version this server serves, `Mcp-Method` must be present and must equal
 * the body's method, and `Mcp-Name` must be present and equal for the methods
 * that carry a name. A request without the header is a legacy client and is
 * served the older shape, which required none of those headers.
 *
 * THE HEADER-BODY COMPARISON IS THE POINT OF THE MODERN RULES, and the spec says
 * why: "This prevents potential security vulnerabilities when different
 * components in the network rely on different sources of truth (e.g., a load
 * balancer routing on the header value while the MCP server executes based on
 * the body value)." Foxhound rate-limits on a header, so it is exactly the
 * intermediary that clause is about.
 */
export function validateMcpRequest(headers: Headers, raw: unknown): McpValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse(400, MCP_ERROR.INVALID_REQUEST, "Request body must be a JSON-RPC object");
  }
  const body = raw as McpRequestBody;
  if (body.jsonrpc !== "2.0") {
    return refuse(400, MCP_ERROR.INVALID_REQUEST, "jsonrpc must be \"2.0\"");
  }
  if (typeof body.method !== "string" || body.method.length === 0) {
    return refuse(400, MCP_ERROR.INVALID_REQUEST, "method is required");
  }
  // A JSON-RPC notification has no id. The spec: the server "MUST return HTTP
  // status code 202 Accepted with no body".
  const isNotification = body.id === undefined || body.id === null;

  const versionHeader = headers.get("mcp-protocol-version");
  if (!versionHeader) {
    return { ok: true, era: "legacy", body, isNotification };
  }

  if (
    versionHeader !== MCP_PROTOCOL_VERSION &&
    !(MCP_LEGACY_VERSIONS as readonly string[]).includes(versionHeader)
  ) {
    return refuse(
      400,
      MCP_ERROR.INVALID_REQUEST,
      `Unsupported protocol version ${versionHeader}. Supported: ${[MCP_PROTOCOL_VERSION, ...MCP_LEGACY_VERSIONS].join(", ")}`,
    );
  }

  const metaVersion = metaProtocolVersion(body);
  if (metaVersion !== null && metaVersion !== versionHeader) {
    return refuse(
      400,
      MCP_ERROR.HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header value '${versionHeader}' does not match body value '${metaVersion}'`,
    );
  }

  const methodHeader = headers.get("mcp-method");
  if (!methodHeader) {
    return refuse(400, MCP_ERROR.HEADER_MISMATCH, "Header mismatch: Mcp-Method is required");
  }
  if (methodHeader !== body.method) {
    return refuse(
      400,
      MCP_ERROR.HEADER_MISMATCH,
      `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${body.method}'`,
    );
  }

  // `Mcp-Name` mirrors params.name or params.uri, and is required for exactly
  // the three methods that carry one.
  if (NAMED_METHODS.has(body.method)) {
    const nameHeader = headers.get("mcp-name");
    const bodyName = pickBodyName(body);
    if (!nameHeader) {
      return refuse(400, MCP_ERROR.HEADER_MISMATCH, "Header mismatch: Mcp-Name is required");
    }
    if (bodyName !== null && decodeHeaderValue(nameHeader) !== bodyName) {
      return refuse(
        400,
        MCP_ERROR.HEADER_MISMATCH,
        `Header mismatch: Mcp-Name header value '${nameHeader}' does not match body value '${bodyName}'`,
      );
    }
  }

  return { ok: true, era: "modern", body, isNotification };
}

const NAMED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

function pickBodyName(body: McpRequestBody): string | null {
  const name = body.params?.["name"];
  if (typeof name === "string") return name;
  const uri = body.params?.["uri"];
  return typeof uri === "string" ? uri : null;
}

/**
 * Decode the spec's Base64 sentinel, `=?base64?VALUE?=`, which a client MUST use
 * when a name cannot be represented as plain ASCII. Servers "MUST decode an
 * encoded Mcp-Name ... value before comparing it to the corresponding request
 * body value", so skipping this would reject legitimate non-ASCII tool names.
 */
export function decodeHeaderValue(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    const encoded = value.slice("=?base64?".length, -"?=".length);
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // Undecodable: return it unchanged so the comparison fails loudly rather
    // than throwing inside a validator.
    return value;
  }
}

/** A JSON-RPC error response body. `id` is null when the request had none. */
export function mcpErrorBody(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A JSON-RPC success response body. */
export function mcpResultBody(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * The legacy era's `initialize` result.
 *
 * IT ECHOES THE CLIENT'S REQUESTED VERSION when that version is one this server
 * serves, which is the negotiation the older revisions specify, and otherwise
 * answers with its own. `capabilities.tools` is present and empty: this server
 * has a tools capability with no tools registered yet, which is a different
 * statement from having no tools capability at all.
 */
export function initializeResult(requestedVersion: string | null) {
  const version =
    requestedVersion && (MCP_LEGACY_VERSIONS as readonly string[]).includes(requestedVersion)
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    serverInfo: MCP_SERVER_INFO,
    capabilities: { tools: { listChanged: false } },
  };
}
