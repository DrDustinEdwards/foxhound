import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { privateRobotsResponse } from "@drdustinedwards/site-helpers/robots";
import { adminMcpWorker } from "@dustinedwards/site-runtime/admin-mcp";
import { foxhoundMcp } from "@dustinedwards/site-runtime/sites";

import type { AdminMcpEnv } from "./env";
import { isFoxhoundAdmin } from "./guard";
import { SERVER, serveAdminMcp } from "./server";

// The Worker's own two Durable Objects, both site-runtime's: the door's rate
// limit (MCP_RATE_LIMIT) and the append-only tool-call log (TOOL_CALL_LOG).
// Neither holds money or reaches Foxhound's data.
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

// foxhound-admin-mcp: the Foxhound Admin MCP Worker at admin-mcp.foxhoundapp.com
// (job_21de68b30fc2; MCP ruling 2026-10-10, rules 9, 12 and 13). The one
// exception to Foxhound's single-Worker rule, kept apart so that the process an
// admin AI talks to holds no Stripe key, no money binding and no database:
// everything it does is a call to the admin API on the foxhound Worker.
//
// The Worker is site-runtime's adminMcpWorker, the door every admin MCP server
// shares: the Origin and Host checks, the list-only test key, the OAuth provider
// bound to PUBLIC_ORIGIN + /mcp (CIMD, and tightened registration for Grok and
// Gemini), the Cloudflare Access sign-in, the rate limit, /owner, /health and
// the tool-call log's daily copy (L6-L7).
//
// WHO IS AN ADMIN IS NEVER DECIDED HERE. `admit` puts the verified email to the
// admin API's /me, which answers from Foxhound's ADMIN_EMAIL, at sign-in and on
// every request; on every tool call the API asks again. A person dropped from
// ADMIN_EMAIL loses this door on their next request, whatever grant this Worker
// still holds.

export default adminMcpWorker<AdminMcpEnv>({
  name: "Foxhound Admin",
  server: SERVER,
  site: foxhoundMcp,
  // The network's address and Expires, as foxhoundapp.com sends.
  securityTxt: { contact: "security@dustinedwards.info", expires: "2027-09-28T00:00:00Z" },
  about: `<p>It can read Foxhound. With changes allowed, it can also pause merchants, stage changes and send test emails to your own inbox.</p>
<p>It can never refund, adjust, cancel or disconnect anything. Resuming, releasing the brake, enabling a cron and billing exemption are only staged, for you to confirm in /admin/staged.</p>`,
  admit: (env, user) => isFoxhoundAdmin(env, user.email.toLowerCase()),
  // FOXHOUND must be bound (fail). site-runtime's foxhound-reach check sends one request to the AdminApi entrypoint,
  // which answers any path outside /api/admin/v1 with its 404 before it reads D1, a key or its log.
  api: { binding: "FOXHOUND", name: "foxhound" },
  OAuthProvider,
  serve: (request, env, _ctx, caller) => {
    if (caller.kind === "admin") {
      const { props, scopes, auth } = caller;
      const clientId = typeof props.clientId === "string" ? props.clientId : undefined;
      return serveAdminMcp(request, env, {
        actor: props.email,
        client:
          typeof props.client === "string" && props.client ? props.client : "an unnamed AI client",
        clientId,
        scopes,
        // The verified token, so the SDK can send a write's 403 step-up before the tool runs.
        authInfo: {
          token: auth.token,
          clientId: auth.clientId ?? clientId ?? "",
          scopes: [...scopes],
          expiresAt: auth.expiresAt,
          resource: new URL(auth.audience),
          extra: { props: { email: props.email } },
        },
      });
    }
    // The list-only test key: it never reaches the admin API (agent keys are off on this server).
    return serveAdminMcp(request, env, {
      actor: caller.principal,
      client: "the list-only test key",
      scopes: [],
      probe: true,
    });
  },
  // The door is for machines: its robots.txt is Prelum's private-host response, Disallow: / for every crawler.
  routes: (request) =>
    new URL(request.url).pathname === "/robots.txt" ? privateRobotsResponse() : null,
});
