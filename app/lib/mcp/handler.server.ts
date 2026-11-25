import { clientIp, jsonResponse } from "@dustinedwards/site-runtime/http";
import {
  errorMessage,
  logEvent,
  OWASP_EVENTS,
  requestFields,
} from "@dustinedwards/site-runtime/log";
import { readCapped } from "@dustinedwards/site-runtime/body";
import { recordAudit } from "@dustinedwards/site-runtime/audit-log";
import { bearerToken } from "@dustinedwards/site-runtime/agent-keys";
import {
  checkRateLimit,
  mcpOriginRefusal,
  probeDoor,
  unauthorized as bearerChallenge,
} from "@dustinedwards/site-runtime/mcp-server";
import { getDb } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { RATE_LIMIT_MCP_ANON } from "~/lib/http/rate-limit-buckets";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { mcpResource, MERCHANT_SCOPES } from "~/lib/oauth/metadata";

import {
  answersIn,
  recordToolCalls,
  startToolCalls,
  toolCallsIn,
  type StartedCall,
} from "./call-log.server";
import { EMPTY_REGISTRY, type McpToolRegistry } from "./registry";
import { MCP_SERVER, MCP_SERVER_INFO, serveAdminMcp } from "./server";

// The merchant MCP endpoint: the door, not the protocol. It decides who may call (origin, bearer key, scope, demo refusal,
// rate limits) and hands an authenticated request to the SDK in ./server.ts. Stateless Streamable HTTP at /mcp, mounted
// at the Worker level (JSON-RPC over POST has no loader/action machinery). No session, no user, no Durable Object:
// `verifyMcpToken` resolves an ACCOUNT from a bearer key, which is what makes the HUMAN-FOREVER five enforceable
// (`dispute_approvals.approved_by_user_id` cannot be satisfied by a caller with no user). Scope is per tool: the key's
// scopes go to the SDK as authInfo, and a call the key may not make gets 403 insufficient_scope naming what it needs.
// The 401 is byte-stable across every failure (missing header, wrong scheme or prefix, unknown or revoked key, admin
// scope), so a varying body cannot tell an attacker a guess was a real revoked key. Its WWW-Authenticate carries RFC 9728
// resource_metadata and the least scope (merchant.read) so a client finds /oauth/authorize; that is site-runtime's challenge.

const MCP_ERROR = { INVALID_REQUEST: -32600 } as const;
const INTERNAL_ERROR = -32603;

function mcpErrorBody(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const AUDIT_SERVER = { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version };

interface McpAuthContext {
  keyId: string;
  accountId: string;
  scopes: string[];
  clientId: string | null;
}

function tooMany(retryAfter: number): Response {
  return jsonResponse(mcpErrorBody(null, MCP_ERROR.INVALID_REQUEST, "Too many requests"), 429, {
    "Retry-After": String(retryAfter),
  });
}

const UNAUTHORIZED_MESSAGE = "Unauthorized";

function rpcErrorResponse(
  status: number,
  id: string | number | null,
  code: number,
  message: string,
): Response {
  return jsonResponse(mcpErrorBody(id, code, message), status);
}

function unauthorized(origin: string): Response {
  const challenge = bearerChallenge({
    resource: mcpResource(origin),
    scope: [MERCHANT_SCOPES.read],
  });
  return jsonResponse(mcpErrorBody(null, MCP_ERROR.INVALID_REQUEST, UNAUTHORIZED_MESSAGE), 401, {
    "WWW-Authenticate": challenge.headers.get("www-authenticate") ?? "",
  });
}

/** Resolve the caller, or refuse. The anon rate limit is spent only on failure: spending it on every request would cap a
 *  team behind one NAT for no gain, since a real agent has its own key bucket. Known cost: one indexed
 *  `api_keys.key_hash` lookup precedes the anon check, so a flood of well-formed random keys costs one D1 read each until
 *  the per-IP cap bites; volumetric floods are absorbed at Cloudflare's edge. */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ ok: true; auth: McpAuthContext } | { ok: false; response: Response }> {
  const ip = clientIp(request);
  const refuse = async (reason: string) => {
    // site-runtime's checkRateLimit fails closed: a limiter that cannot answer is a 429, never a free guess.
    const limit = await checkRateLimit(env.RATE_LIMITER, `mcp-anon:${ip}`, RATE_LIMIT_MCP_ANON.max);
    // The reason is logged, never returned, so the response stays byte-stable. At log level: a refused connect is expected traffic.
    logEvent(OWASP_EVENTS.signInFailure, { ...requestFields(request), door: "mcp", reason });
    if (!limit.allowed) {
      logEvent(
        OWASP_EVENTS.rateLimitExceeded,
        { ...requestFields(request), door: "mcp", bucket: "mcp-anon" },
        { level: "warn" },
      );
      return tooMany(limit.retryAfter);
    }
    return unauthorized(new URL(request.url).origin);
  };

  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return { ok: false, response: await refuse("no bearer token") };
  if (!token.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, response: await refuse("wrong token prefix") };
  }

  const verified = await verifyMcpToken(getDb(env), token);
  if (!verified) return { ok: false, response: await refuse("unknown or revoked key") };

  // An admin key is refused here: an `mcp_admin` key verifies fine with `account_id = null`, and accepting it would hand
  // every account-scoped helper a null account. An admin surface would be a different route with its own tool list.
  if (verified.scope !== MCP_TOKEN_SCOPE.MERCHANT) {
    return { ok: false, response: await refuse("admin scope on the merchant endpoint") };
  }
  if (!verified.accountId) {
    return { ok: false, response: await refuse("merchant key with no account") };
  }

  // Demo accounts cannot drive this endpoint. No demo key should exist (every mutating demo request is 405'd), so this is
  // defense in depth, using the same prefix constant as accountProcessingEligibleCondition.
  if (verified.accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) {
    return { ok: false, response: await refuse("demo account key") };
  }

  return {
    ok: true,
    auth: {
      keyId: verified.keyId,
      accountId: verified.accountId,
      scopes: verified.scopes,
      clientId: verified.clientId,
    },
  };
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  registry: McpToolRegistry = EMPTY_REGISTRY,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return null;

  if (request.method !== "POST") {
    return jsonResponse(
      mcpErrorBody(null, MCP_ERROR.INVALID_REQUEST, "The MCP endpoint accepts POST only"),
      405,
      { Allow: "POST" },
    );
  }

  // Origin is validated before anything else (MCP spec: DNS rebinding). Only a browser sends one, so an ABSENT Origin is
  // normal and only a PRESENT foreign one is refused (site-runtime's check).
  const foreign = mcpOriginRefusal(request);
  if (foreign) return foreign;

  // The list-only test key: the secret MCP_PROBE_KEY lets the daily live check connect and list the read tools and nothing
  // else. It names no account and no D1 lookup happens. site-runtime's probeDoor refuses anything but the handshake, ping
  // or a list before the SDK runs; the key holds no scope. No key, or no secret set, is null: on to the merchant keys.
  const probed = await probeDoor(request, env, {
    server: MCP_SERVER,
    limiter: env.RATE_LIMITER,
    serve: (req, caller) => {
      const now = new Date();
      return serveAdminMcp(
        req,
        registry,
        {
          env,
          db: getDb(env),
          accountId: "",
          now,
          trace: { apiKeyId: caller.principal, tool: "", now },
        },
        null,
      );
    },
  });
  if (probed) return probed;

  const authenticated = await authenticate(request, env);
  if (!authenticated.ok) return authenticated.response;

  // The authed bucket is keyed on the key id, not the IP (the caller of an agent endpoint is the key). The id rather than
  // the token hash: verifyMcpToken already resolved it (no second SHA-256) and an opaque row id is safer in a Durable
  // Object name. site-runtime's checkRateLimit: thirty requests a minute per key, failing closed; a refusal is a
  // `rate-limited` row in the shared log.
  const caller = {
    accountId: authenticated.auth.accountId,
    apiKeyId: authenticated.auth.keyId,
    clientId: authenticated.auth.clientId,
  };
  const limit = await checkRateLimit(env.RATE_LIMITER, `mcp:${authenticated.auth.keyId}`);
  if (!limit.allowed) {
    logEvent(
      OWASP_EVENTS.rateLimitExceeded,
      { ...requestFields(request), door: "mcp", bucket: "mcp" },
      { level: "warn" },
    );
    await recordAudit(env, {
      callId: crypto.randomUUID(),
      phase: "rate-limited",
      caller: `agent:key_${caller.apiKeyId}`,
      server: AUDIT_SERVER,
      ...(caller.clientId ? { clientId: caller.clientId } : {}),
    });
    return tooMany(limit.retryAfter);
  }

  // The tool calls in this request, read to a ceiling before the SDK sees the body, so the call log sees every call past
  // the door. A body that is not JSON holds no call; the SDK answers it with a parse error.
  const text = await readCapped(request, BODY_MAX_BYTES);
  if (text === null)
    return rpcErrorResponse(413, null, MCP_ERROR.INVALID_REQUEST, "Request body too large");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const calls = toolCallsIn(body);

  // Each call's `started` row is written BEFORE anything runs, and a call whose row cannot be written is refused: no tool runs untraced.
  let started: StartedCall[] = [];
  try {
    started = await startToolCalls(env, AUDIT_SERVER, caller, calls);
  } catch (err) {
    logEvent(
      "sys_monitor_disabled",
      {
        ...requestFields(request),
        door: "mcp",
        reason: "tool-call log unavailable",
        detail: errorMessage(err),
      },
      { level: "error" },
    );
    return rpcErrorResponse(
      503,
      null,
      INTERNAL_ERROR,
      "The call log is unavailable, so no tool was run. Try again shortly.",
    );
  }

  const now = new Date();
  const response = await serveAdminMcp(
    new Request(request, { method: request.method, body: text }),
    registry,
    {
      env,
      db: getDb(env),
      accountId: authenticated.auth.accountId,
      now,
      trace: { apiKeyId: authenticated.auth.keyId, tool: "", now },
    },
    {
      token: "",
      clientId: authenticated.auth.clientId ?? authenticated.auth.keyId,
      scopes: authenticated.auth.scopes,
      resource: new URL(mcpResource(url.origin)),
    },
  );
  // Belt and braces with the worker's cache policy: an answer carrying a merchant's data must never be stored by an intermediary.
  if (calls.length > 0) {
    const text = await response.clone().text();
    // A step-up answers the HTTP request, not the call, so the call is logged with the challenge as its error.
    const challenge = response.status === 403 ? response.headers.get("www-authenticate") : null;
    await recordToolCalls(
      env,
      AUDIT_SERVER,
      getDb(env),
      caller,
      calls,
      started,
      challenge
        ? calls.map((call) => ({
            id: call.id,
            error: { message: `Refused before running: ${challenge}` },
          }))
        : answersIn(text, response.headers.get("content-type")),
      now,
    );
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
