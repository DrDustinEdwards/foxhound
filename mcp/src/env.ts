// What the Foxhound Admin MCP Worker is given (mcp/wrangler.jsonc), and nothing
// more. Declared here rather than taken from the app's generated Env, because
// this Worker shares no binding with the app: no D1, no Stripe key, no money
// writer, no queue. Its one way into Foxhound is FOXHOUND, a service binding to
// the foxhound Worker, and the admin API behind it. Its two Durable Objects are
// its own (index.ts): the door's rate limit and the tool-call log; its one R2
// bucket holds only that log's copies. What the shared door reads (OAUTH_KV,
// MCP_RATE_LIMIT, TOOL_CALL_LOG, AUDIT_BUCKET, PUBLIC_ORIGIN, the Access for
// SaaS settings, DCR_REDIRECT_URIS, MCP_PROBE_KEY, DEPLOY_SHA) is site-runtime's
// AdminMcpEnv.

import type { AdminMcpEnv as DoorEnv } from "@dustinedwards/site-runtime/admin-mcp";

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface AdminMcpEnv extends DoorEnv {
  /** Service binding to the foxhound Worker. The only route to Foxhound. */
  FOXHOUND: ServiceBinding;
  /** The mcp_admin key (scripts/issue-admin-api-key.mjs). Secret. */
  FOXHOUND_ADMIN_API_KEY?: string;
}
