import { adminDoor } from "./door";
import type { AdminMcpEnv } from "./env";

// foxhound-admin-mcp: the Foxhound Admin MCP Worker at admin-mcp.foxhoundapp.com
// (job_21de68b30fc2). The one exception to Foxhound's single-Worker rule, kept
// apart so that the process an admin AI talks to holds no Stripe key, no money
// binding and no database: everything it does is a call to the admin API on the
// foxhound Worker. See door.ts for the routes.

export default {
  fetch: (request: Request, env: AdminMcpEnv, ctx: ExecutionContext) => adminDoor(request, env, ctx),
} satisfies ExportedHandler<AdminMcpEnv>;
