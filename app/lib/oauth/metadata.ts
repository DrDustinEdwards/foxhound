// The two discovery documents, and the scopes they name.

import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

/** Paths the documents name. Each is a route in app/routes.ts, and
 *  test/oauth-provider-j79.test.ts fails if one is not. */
const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
  revoke: "/api/oauth/revoke",
  protectedResource: "/.well-known/oauth-protected-resource",
  mcp: "/mcp",
} as const;

/**
 * Least scope first (MCP ruling 2026-10-10, rule 12.1): merchant.read is what
 * every connection gets, and merchant.write, which the two tools that change
 * settings and alerts need, only when the owner ticks "Allow changes" on the
 * consent page.
 */
export const MERCHANT_SCOPES = mcpScopes("merchant");

// "merchant", the one scope Foxhound issued before the split, is no longer
// listed. A client that still asks for it gets the read grant (requestsWrite
// sees no merchant.write), and a grant made with it was backfilled read only
// (drizzle/migrations/0065_merchant_mcp_scopes.sql).

/** What a grant holds: the read scope always, the write scope when the owner
 *  ticked it. Never what the client asked for. */
export function grantedScopes(allowWrite: boolean): string[] {
  return allowWrite ? [...MERCHANT_SCOPES.all] : [MERCHANT_SCOPES.read];
}

/** Whether a client's requested scope string asks for changes, so the consent
 *  page can start the box ticked. Only merchant.write does. */
export function requestsWrite(requested: string | null): boolean {
  return (requested ?? "").split(" ").includes(MERCHANT_SCOPES.write);
}

/** The scopes a key holds. A key with none recorded is read only, the least,
 *  so a row the backfill missed can never write. */
export function keyScopes(stored: readonly string[] | null | undefined): string[] {
  const known = (stored ?? []).filter((s) => s === MERCHANT_SCOPES.read || s === MERCHANT_SCOPES.write);
  return known.includes(MERCHANT_SCOPES.write) ? [...MERCHANT_SCOPES.all] : [MERCHANT_SCOPES.read];
}

/**
 * RFC 8414 authorization-server metadata, Recova's fields
 * (app/api/oauth/metadata/route.ts, fed513c8) with the issuer taken from the
 * request's own origin, as Recova derived it, so the document always names the
 * host the client reached.
 *
 * Two fields Recova did not have, both required by the MCP authorization spec:
 *   - client_id_metadata_document_supported: a client may use the URL of its
 *     metadata document as its client_id, and the authorize step fetches and
 *     validates that document (./client-metadata.server.ts). Recova advertised
 *     this and its authorize page answered such a client "Unknown client",
 *     because nothing ever fetched one; advertising what does not exist is the
 *     defect RULES.md 2.7 names, so it is advertised here only because it is
 *     done.
 *   - authorization_response_iss_parameter_supported (RFC 9207): every redirect
 *     back to the client carries iss, so a client talking to several servers
 *     can tell which one answered.
 */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${origin}${OAUTH_PATHS.revoke}`,
    registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MERCHANT_SCOPES.all,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * RFC 9728 protected-resource metadata for /mcp, which recova-mcp served
 * (api/well-known/oauth-protected-resource.ts, 6569e1a3) and its 401 pointed
 * at. Recova's lived on a separate MCP host; Foxhound's /mcp shares this
 * origin, so the resource and its authorization server are one host.
 *
 * Recova's resource_signing_alg_values_supported: ['RS256'] is not carried:
 * nothing here signs a resource response. Its 'admin' scope is not carried
 * either, because the merchant /mcp refuses every non-merchant key
 * (app/lib/mcp/handler.server.ts) and the admin MCP is its own Worker.
 */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: MERCHANT_SCOPES.all,
  };
}

/** The resource every token here is issued for (RFC 8707): the /mcp endpoint
 *  on this origin. */
export function mcpResource(origin: string): string {
  return `${origin}${OAUTH_PATHS.mcp}`;
}
