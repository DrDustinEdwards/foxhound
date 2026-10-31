// Test-only entry for the authorization-server half of `npm run check:conformance`.
// NEVER DEPLOYED. It mounts the real door (mcp/src/door.ts), OAuth provider
// included, as mcp/src/index.ts does. No Access for SaaS secrets are set, which
// only shuts /authorize; the metadata this half certifies is served anyway.

import { adminDoor } from "../src/door";
import type { AdminMcpEnv } from "../src/env";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default {
  fetch: (request: Request, env: AdminMcpEnv, ctx: ExecutionContext) => adminDoor(request, env, ctx),
};
