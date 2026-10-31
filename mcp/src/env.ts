// What the Foxhound Admin MCP Worker is given (mcp/wrangler.jsonc), and nothing
// more. Declared here rather than taken from the app's generated Env, because
// this Worker shares no binding with the app: no D1, no Stripe key, no money
// writer, no queue. Its one way into Foxhound is FOXHOUND, a service binding to
// the foxhound Worker, and the admin API behind it. Its two Durable Objects are
// its own (index.ts): the door's rate limit and the tool-call log.

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface AdminMcpEnv {
  /** Service binding to the foxhound Worker. The only route to Foxhound. */
  FOXHOUND: ServiceBinding;
  /** The mcp_admin key (scripts/issue-admin-api-key.mjs). Secret. */
  FOXHOUND_ADMIN_API_KEY?: string;
  /** Grants and tokens for workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** The door's limiter, site-runtime's RateLimiter (checkRateLimit fails closed without it). */
  MCP_RATE_LIMIT?: DurableObjectNamespace;
  /** The append-only, hash-chained tool-call log, site-runtime's ToolCallLog. No tool runs unlogged. */
  TOOL_CALL_LOG?: DurableObjectNamespace;
  /** Cloudflare Access for SaaS, the upstream sign-in (@dustinedwards/site-runtime/access-login). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  /** This Worker's own origin. Defaults to https://admin-mcp.foxhoundapp.com. */
  ADMIN_MCP_ORIGIN?: string;
  /** Extra exact registration callbacks, space or comma separated, beside site-runtime's DCR_CALLBACKS (door.ts). */
  DCR_REDIRECT_URIS?: string;
}
