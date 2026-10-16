// The two discovery documents (J79, rows F18 and F19).

/** Paths the documents name. Each is a route in app/routes.ts, and
 *  test/oauth-provider-j79.test.ts fails if one is not (RULES.md 2.7). */
export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
  revoke: "/api/oauth/revoke",
  protectedResource: "/.well-known/oauth-protected-resource",
  mcp: "/mcp",
} as const;

/** The one scope Foxhound issues: the merchant MCP for one account. */
export const OAUTH_SCOPE = "merchant";

/**
 * RFC 8414 authorization-server metadata, Recova's fields
 * (app/api/oauth/metadata/route.ts, fed513c8) with the issuer taken from the
 * request's own origin, as Recova derived it, so the document always names the
 * host the client reached.
 *
 * ONE OF RECOVA'S FIELDS IS NOT CARRIED: client_id_metadata_document_supported.
 * Recova advertised it, and its authorize page answered such a client "Unknown
 * client", because nothing ever fetched a metadata document. Advertising what
 * does not exist is the defect RULES.md 2.7 names.
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
    scopes_supported: [OAUTH_SCOPE],
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
    resource: `${origin}${OAUTH_PATHS.mcp}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** The WWW-Authenticate value on every /mcp 401: where a client finds the
 *  authorization server (recova-mcp src/auth.ts, wwwAuthenticateHeader). */
export function mcpWwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${origin}${OAUTH_PATHS.protectedResource}", scope="${OAUTH_SCOPE}"`;
}
