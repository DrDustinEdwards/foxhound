import { exportAuditLog } from "@dustinedwards/site-runtime/audit-log";
import { logEvent } from "@dustinedwards/site-runtime/log";

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

export default {
  fetch: (request: Request, env: AdminMcpEnv, ctx: ExecutionContext) => adminDoor(request, env, ctx),
  // The daily copy of the tool-call log to AUDIT_BUCKET and the 90-day prune of copied rows (L6-L7). A failed write
  // throws, so the run shows failed; /health's tool-call-log check alerts once rows go uncopied for two days (L8).
  scheduled: async (_controller: ScheduledController, env: AdminMcpEnv) => {
    if (!env.AUDIT_BUCKET) throw new Error("AUDIT_BUCKET is not bound; the tool-call log is not copied");
    const done = await exportAuditLog(env as Parameters<typeof exportAuditLog>[0], env.AUDIT_BUCKET);
    logEvent("tool_call_log_exported", { exported: done.exported, pruned: done.pruned });
  },
} satisfies ExportedHandler<AdminMcpEnv>;
