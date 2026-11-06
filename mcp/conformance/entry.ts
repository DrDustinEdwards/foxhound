// Test-only entry for `npm run check:conformance`. NEVER DEPLOYED: the deploy
// target is mcp/src/index.ts, and this file is reached only by passing it to
// `wrangler dev` through .conformance.json.
//
// The official suite cannot complete an Access sign-in, so this mounts the REAL
// protocol layer and the REAL tools (mcp/src/server.ts) with the door's token
// check replaced by a fixed read-only session, and the FOXHOUND service binding
// replaced by an admin API that answers every call with an empty success. What
// gets certified is the code that ships. The door is certified separately,
// against auth-entry.ts.

import { SCOPE_READ } from "../src/scopes";
import { serveAdminMcp } from "../src/server";
import type { AdminMcpEnv } from "../src/env";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

const EMPTY_API = { fetch: async () => Response.json({ ok: true, data: {} }) };

export default {
  fetch(request: Request, env: AdminMcpEnv) {
    return serveAdminMcp(request, { ...env, FOXHOUND: EMPTY_API, FOXHOUND_ADMIN_API_KEY: "conformance-key-not-a-secret-0000" }, {
      actor: "admin@conformance.invalid",
      client: "conformance suite",
      scopes: [SCOPE_READ],
    });
  },
};
