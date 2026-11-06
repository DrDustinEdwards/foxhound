// Test-only entry for the authorization-server half of `npm run check:conformance`.
// NEVER DEPLOYED. It mounts the real Worker (mcp/src/index.ts, site-runtime's
// adminMcpWorker), OAuth provider included. No Access for SaaS secrets are set, which
// only shuts /authorize; the metadata this half certifies is served anyway.

import worker from "../src/index";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

export default worker;
