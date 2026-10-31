import { withRequestLog } from "@dustinedwards/site-runtime/log";

import { adminDoor } from "./door";
import type { AdminMcpEnv } from "./env";

// The Worker's own two Durable Objects, both site-runtime's: the door's rate
// limit (MCP_RATE_LIMIT) and the append-only tool-call log (TOOL_CALL_LOG).
// Neither holds money or reaches Foxhound's data.
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

// foxhound-admin-mcp: the Foxhound Admin MCP Worker at admin-mcp.foxhoundapp.com
// (job_21de68b30fc2). The one exception to Foxhound's single-Worker rule, kept
// apart so that the process an admin AI talks to holds no Stripe key, no money
// binding and no database: everything it does is a call to the admin API on the
// foxhound Worker. See door.ts for the routes.

// One `request` line per request (site-runtime ./log: path, status, ms and the deployed commit; never a query).
export default {
  fetch: withRequestLog((request: Request, env: AdminMcpEnv, ctx: ExecutionContext) => adminDoor(request, env, ctx), {
    sha: (env) => env.DEPLOY_SHA,
  }),
} satisfies ExportedHandler<AdminMcpEnv>;
