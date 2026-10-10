import { getDb } from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  RATE_LIMIT_MCP,
  RATE_LIMIT_MCP_ANON,
} from "~/lib/constants";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE, verifyMcpToken } from "~/lib/auth/mcp-tokens";
import { isWithinRateLimit } from "~/lib/http/rate-limit";

import { EMPTY_REGISTRY, type McpToolRegistry } from "./registry";
import { serveMcp } from "./server";

// THE MERCHANT MCP ENDPOINT (370, roadmap item 3; brought to the 2026-10-10
// MCP ruling by job_874dc20ea9ac).
//
// THIS FILE IS THE DOOR, NOT THE PROTOCOL. It decides who may call (origin,
// bearer key, scope, demo refusal, rate limits) and hands an authenticated
// request to the official SDK in ./server.ts, which speaks both protocol eras.
//
// Stateless Streamable HTTP at /mcp, mounted at the WORKER level rather than as
// a React Router route, because this is JSON-RPC over POST with its own header
// contract and none of the router's loader/action machinery applies. It matches
// how the worker entry already handles cross-cutting concerns before the router:
// the rate-limit check and the cache policy run there for the same reason.
//
// NO SESSION, NO USER, NO DURABLE OBJECT. The 2026-07-28 revision removed
// protocol-level sessions, so every request is self-contained and the endpoint
// is horizontally stateless. `verifyMcpToken` resolves an ACCOUNT from a bearer
// key; nothing on this path calls `getSession` and there is no user identity
// anywhere in it. That is what makes the HUMAN-FOREVER five enforceable rather
// than merely policy: `dispute_approvals.approved_by_user_id` cannot be
// satisfied by a caller that has no user.
//
// THE 401 IS BYTE-STABLE ACROSS EVERY FAILURE. Missing header, wrong scheme,
// wrong prefix, unknown key, revoked key and admin-scope-on-the-merchant-path
// all produce the SAME body and the same status. A body that varied would tell
// an attacker which of their guesses was a real key that had been revoked, which
// is the classic user-enumeration leak wearing different clothes.

/** JSON-RPC codes this file answers with itself, before the SDK is reached. */
const MCP_ERROR = { INVALID_REQUEST: -32600 } as const;

function mcpErrorBody(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** What the endpoint resolved before dispatching. */
export interface McpAuthContext {
  keyId: string;
  accountId: string;
}

const UNAUTHORIZED_MESSAGE = "Unauthorized";

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Belt and braces with the worker's own cache policy, which classifies
      // /mcp private by default. An answer carrying a merchant's data must
      // never be stored by an intermediary.
      "Cache-Control": "private, no-store",
      ...extra,
    },
  });
}

function errorResponse(
  status: number,
  id: string | number | null,
  code: number,
  message: string,
): Response {
  return jsonResponse(status, mcpErrorBody(id, code, message));
}

/** The one 401. Identical for every authentication failure. */
function unauthorized(): Response {
  return jsonResponse(
    401,
    mcpErrorBody(null, MCP_ERROR.INVALID_REQUEST, UNAUTHORIZED_MESSAGE),
    { "WWW-Authenticate": "Bearer" },
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the caller, or refuse.
 *
 * THE ANON RATE LIMIT IS SPENT ONLY ON FAILURE, and that is deliberate. Spending
 * it on every request would put a per-IP cap on legitimate agents, which breaks
 * a team behind one NAT for no security gain, since a real agent is already
 * capped by its own key bucket. Spending it on failures caps key guessing where
 * the guessing happens.
 *
 * THE COST THAT IS NOT COVERED, STATED: one indexed `api_keys.key_hash` lookup
 * happens before the anon limit is consulted, so a flood of syntactically valid
 * random keys costs one D1 read each until the per-IP cap bites. That read is a
 * single point lookup and volumetric floods are absorbed at Cloudflare's edge
 * before the Worker runs. Recorded rather than hidden, because a limiter that
 * looks like it protects the database here does not quite.
 */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ ok: true; auth: McpAuthContext } | { ok: false; response: Response }> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const refuse = async (reason: string) => {
    const allowed = await isWithinRateLimit(
      env,
      "mcp-anon",
      ip,
      RATE_LIMIT_MCP_ANON.max,
      RATE_LIMIT_MCP_ANON.windowMs,
    );
    // Debug level: a refused connect is expected traffic on a public endpoint.
    // The reason is logged, never returned, so the response stays byte-stable.
    console.debug("mcp auth refused:", reason);
    if (!allowed) {
      return errorResponse(429, null, MCP_ERROR.INVALID_REQUEST, "Too many requests");
    }
    return unauthorized();
  };

  const token = bearerToken(request);
  if (!token) return { ok: false, response: await refuse("no bearer token") };
  if (!token.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, response: await refuse("wrong token prefix") };
  }

  const verified = await verifyMcpToken(getDb(env), token);
  if (!verified) return { ok: false, response: await refuse("unknown or revoked key") };

  // AN ADMIN KEY IS REFUSED HERE, and this is the separation 370 named. An
  // `mcp_admin` key verifies fine and carries `account_id = null`; if this path
  // accepted it, every account-scoped helper would receive a null account and
  // the byAccount predicates would either throw or read broadly. The admin
  // surface, if it is ever built, is a different route with its own tool list.
  if (verified.scope !== MCP_TOKEN_SCOPE.MERCHANT) {
    return { ok: false, response: await refuse("admin scope on the merchant endpoint") };
  }
  if (!verified.accountId) {
    return { ok: false, response: await refuse("merchant key with no account") };
  }

  // DEMO ACCOUNTS CANNOT DRIVE THIS ENDPOINT. S29's page refuses a demo
  // merchant at the form (every mutating demo request is 405'd), so no demo key
  // should exist; `createAccountApiKey` itself carries no such check, which
  // makes this defence in depth rather than duplication. It uses the existing
  // prefix constant, the same one accountProcessingEligibleCondition uses, and
  // changes no firewall.
  if (verified.accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) {
    return { ok: false, response: await refuse("demo account key") };
  }

  return { ok: true, auth: { keyId: verified.keyId, accountId: verified.accountId } };
}

/**
 * The endpoint. Returns null when the request is not for /mcp, so the worker
 * entry can fall through to the router without a second URL parse there.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  registry: McpToolRegistry = EMPTY_REGISTRY,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return null;

  // "HTTP GET or DELETE to the MCP endpoint: respond with 405 Method Not
  // Allowed." Everything that is not POST gets the same, since the endpoint
  // supports exactly one method.
  if (request.method !== "POST") {
    return jsonResponse(
      405,
      mcpErrorBody(null, MCP_ERROR.INVALID_REQUEST, "The MCP endpoint accepts POST only"),
      { Allow: "POST" },
    );
  }

  // ORIGIN IS VALIDATED BEFORE ANYTHING ELSE. "Servers MUST validate the Origin
  // header on all incoming connections to prevent DNS rebinding attacks. If the
  // Origin header is present and invalid, servers MUST respond with HTTP 403."
  // Only a browser sends one; an agent does not, so an ABSENT Origin is normal
  // and only a PRESENT foreign one is refused.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return errorResponse(403, null, MCP_ERROR.INVALID_REQUEST, "Origin not allowed");
  }

  const authenticated = await authenticate(request, env);
  if (!authenticated.ok) return authenticated.response;

  // THE AUTHED BUCKET IS KEYED ON THE KEY ID, not the IP: the caller of an agent
  // endpoint is the key, and an IP is meaningless for a server-to-server client
  // that may move between them. The id rather than the token hash because
  // verifyMcpToken already resolved it, so this costs no second SHA-256, and an
  // opaque row id is a safer thing to put in a Durable Object name than anything
  // derived from a secret.
  const within = await isWithinRateLimit(
    env,
    "mcp",
    authenticated.auth.keyId,
    RATE_LIMIT_MCP.max,
    RATE_LIMIT_MCP.windowMs,
  );
  if (!within) {
    return errorResponse(429, null, MCP_ERROR.INVALID_REQUEST, "Too many requests");
  }

  const now = new Date();
  const response = await serveMcp(request, registry, {
    env,
    db: getDb(env),
    accountId: authenticated.auth.accountId,
    now,
    trace: { apiKeyId: authenticated.auth.keyId, tool: "", now },
  });
  // Belt and braces with the worker's own cache policy: an answer carrying a
  // merchant's data must never be stored by an intermediary, whatever the SDK
  // set. (The 2026-07-28 cache hints in the body are for the client only.)
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
