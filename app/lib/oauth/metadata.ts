// The two discovery documents, and the scopes they name.

import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

/** Paths the documents name. Each is a route in app/routes.ts, and
 *  test/oauth-provider.test.ts fails if one is not. */
const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
  revoke: "/api/oauth/revoke",
  protectedResource: "/.well-known/oauth-protected-resource",
  mcp: "/mcp",
} as const;

/**
 * Least scope first: merchant.read is what every connection gets, and merchant.write, which the two
 * tools that change settings and alerts need, only when the owner ticks "Allow changes" on the
 * consent page.
 */
export const MERCHANT_SCOPES = mcpScopes("merchant");

// "merchant", the one scope Foxhound issued before the split, is no longer listed. A client that
// still asks for it gets the read grant (requestsWrite sees no merchant.write), and a grant made
// with it was backfilled read only (drizzle/migrations/0066_merchant_mcp_scopes.sql).

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
  const known = (stored ?? []).filter(
    (s) => s === MERCHANT_SCOPES.read || s === MERCHANT_SCOPES.write,
  );
  return known.includes(MERCHANT_SCOPES.write) ? [...MERCHANT_SCOPES.all] : [MERCHANT_SCOPES.read];
}

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
 * (api/well-known/oauth-protected-resource.ts, 6569e1a3) and its 401 pointed at.
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
