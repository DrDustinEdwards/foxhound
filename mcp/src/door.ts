import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { recordAudit } from "@dustinedwards/site-runtime/audit-log";
import { foxhoundMcp } from "@dustinedwards/site-runtime/sites";
import {
  DCR_CALLBACKS,
  loginHandler,
  registrationLimited,
  registrationRefusal,
} from "@dustinedwards/site-runtime/mcp-login";
import { audienceRefusal, checkRateLimit, mcpOriginRefusal, refuse, withMcpHeaders } from "@dustinedwards/site-runtime/mcp-server";
import type { AdminMcpEnv } from "./env";
import { adminMcpOrigin, isFoxhoundAdmin, MCP_ROUTE, type DoorProps } from "./guard";
import { SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED } from "./scopes";
import { SERVER, serveAdminMcp } from "./server";

// THE FOXHOUND ADMIN MCP DOOR, everything on admin-mcp.foxhoundapp.com
// (job_21de68b30fc2; MCP ruling 2026-10-10, rules 9, 12 and 13).
//
// This Worker is an OAuth 2.1 authorization server of its own
// (@cloudflare/workers-oauth-provider): CIMD for Claude, Claude Code and
// ChatGPT, a tightened registration for Grok and Gemini, and the person signs in
// upstream through Cloudflare Access for SaaS. The consent page, the sign-in, the
// registration allowlist and its rate limit are site-runtime's mcp-login, as on
// the other admin MCP servers.
//
// WHO IS AN ADMIN IS NEVER DECIDED HERE. At sign-in the verified email is put
// to the admin API's /me, which answers from Foxhound's ADMIN_EMAIL; on every
// tool call the API asks again. A person dropped from ADMIN_EMAIL loses this
// door on their next call, whatever grant this Worker still holds.
//
// Routes, outermost first:
//   /mcp                      a foreign Origin is refused first (403), then the
//                             provider checks the token, then apiHandler checks
//                             its audience, rate-limits the person and hands it
//                             to server.ts
//   /authorize  /callback     the consent page and the Access sign-in
//   /register                 tightened registration (rule 13), rate limited here first
//   /token, /.well-known/*    served by the provider
//   /health                   liveness
//   anything else             404

type DoorEnv = AdminMcpEnv & { OAUTH_PROVIDER: OAuthHelpers };

const REGISTER_PATH = "/register";

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const signIn = loginHandler<DoorEnv & { PUBLIC_ORIGIN?: string }>({
  name: "Foxhound Admin",
  scopes: { read: SCOPE_READ, write: SCOPE_WRITE },
  about: `<p>It can read Foxhound. With changes allowed, it can also pause merchants, stage changes and send test emails to your own inbox.</p>
<p>It can never refund, adjust, cancel or disconnect anything. Resuming, releasing the brake, enabling a cron and billing exemption are only staged, for you to confirm in /admin/staged.</p>`,
  admit: (env, user) => isFoxhoundAdmin(env, user.email.toLowerCase()),
  // Every sign-in, admitted or refused, is a row in the tool-call log.
  audit: { name: SERVER.name, version: SERVER.version },
});

/** The provider's defaultHandler: the shared consent and sign-in, with this Worker's origin for the callback. */
const loginRoutes = {
  fetch: (request: Request, env: DoorEnv) => signIn.fetch(request, { ...env, PUBLIC_ORIGIN: adminMcpOrigin(env) }),
};

/** The exact callbacks a registration may name: the shared fixed ones and DCR_REDIRECT_URIS (space or comma separated). */
function registrationCallbacks(env: AdminMcpEnv): string {
  return [...DCR_CALLBACKS, ...(env.DCR_REDIRECT_URIS ?? "").split(/[\s,]+/).filter((uri) => uri.startsWith("https://"))].join(",");
}

const apiHandler = {
  async fetch(request: Request, env: AdminMcpEnv, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as ExecutionContext & {
      props?: Partial<DoorProps>;
      auth?: { token: string; audience: string; scope: string[]; expiresAt?: number; clientId?: string };
    };
    // The token must have been issued for this server (RFC 8707, rule 12.2).
    const resource = `${adminMcpOrigin(env)}${MCP_ROUTE}`;
    const wrongAudience = audienceRefusal(auth, resource, [SCOPE_READ]);
    if (wrongAudience) return wrongAudience;
    const email = props?.email;
    if (!email) {
      console.warn(JSON.stringify({ door: "refused", reason: "no-email" }));
      return text("Forbidden. This grant names nobody.", 403);
    }
    // Keyed by the signed-in person, the thing worth limiting. Fails closed when
    // the binding is missing; the admin API applies its own limit as well.
    const limit = await checkRateLimit(env.MCP_RATE_LIMIT, `admin:${email.toLowerCase()}`);
    if (!limit.allowed) {
      await recordAudit(env, {
        callId: crypto.randomUUID(),
        phase: "rate-limited",
        caller: `access:${email}`,
        server: { name: SERVER.name, version: SERVER.version },
        clientId: props?.clientId,
      });
      return refuse("Rate limited. Foxhound Admin allows 30 requests a minute.", 429, { "Retry-After": String(limit.retryAfter) });
    }
    const scopes = auth?.scope ?? [];
    const response = await serveAdminMcp(request, env, {
      actor: email,
      client: props?.client || "an unnamed AI client",
      clientId: props?.clientId,
      scopes,
      authInfo: auth && {
        token: auth.token,
        clientId: auth.clientId ?? props?.clientId ?? "",
        scopes,
        expiresAt: auth.expiresAt,
        resource: new URL(resource),
        extra: { props: { email } },
      },
    });
    return response;
  },
};

type ExportedHandlerWithFetch<E> = Required<Pick<ExportedHandler<E>, "fetch">>;

const providers = new Map<string, OAuthProvider<AdminMcpEnv>>();

function providerFor(env: AdminMcpEnv): OAuthProvider<AdminMcpEnv> {
  const origin = adminMcpOrigin(env);
  const allowed = registrationCallbacks(env);
  const key = `${origin} ${allowed}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new OAuthProvider<AdminMcpEnv>({
      apiRoute: MCP_ROUTE,
      apiHandler: apiHandler as unknown as ExportedHandlerWithFetch<AdminMcpEnv>,
      defaultHandler: loginRoutes as unknown as ExportedHandlerWithFetch<AdminMcpEnv>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      scopesSupported: SCOPES_SUPPORTED,
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
        scopes_supported: SCOPES_SUPPORTED,
        resource_name: "Foxhound Admin",
      },
      // CIMD first: claude.ai, Claude Code and ChatGPT send their client_id as a
      // metadata URL. Needs global_fetch_strictly_public (mcp/wrangler.jsonc).
      clientIdMetadataDocumentEnabled: true,
      // Tightened registration beside it, for Grok and Gemini (rule 13).
      clientRegistrationEndpoint: REGISTER_PATH,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const why = registrationRefusal(allowed, clientMetadata);
        return why ? { code: "invalid_redirect_uri", description: why, status: 400 } : undefined;
      },
    });
    providers.set(key, provider);
  }
  return provider;
}

async function route(request: Request, env: AdminMcpEnv, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  // DNS rebinding: a present, foreign Origin is refused before the token is
  // even read. A missing one passes (MCP clients are not browsers), as on the
  // merchant /mcp.
  if (pathname === MCP_ROUTE) {
    const foreign = mcpOriginRefusal(request, []);
    if (foreign) return foreign;
  }
  if (pathname === REGISTER_PATH && request.method === "POST") {
    const limited = await registrationLimited(request, env.OAUTH_KV);
    if (limited) return limited;
  }
  return providerFor(env).fetch(request, env, ctx);
}

/**
 * One request to admin-mcp.foxhoundapp.com. Every response, 404s and the provider's redirects included, leaves with
 * the registry entry's full set, noindex, no-store and the consent page's policy; site-runtime also answers
 * /.well-known/security.txt (the family's address and Expires, as foxhoundapp.com sends) and the report sink.
 */
export const adminDoor = withMcpHeaders<AdminMcpEnv>((request, env, ctx) => route(request, env, ctx as ExecutionContext), {
  site: foxhoundMcp,
  securityTxt: { contact: "security@dustinedwards.info", expires: "2027-09-28T00:00:00Z" },
  allowReport: async (request, env) =>
    (await checkRateLimit(env.MCP_RATE_LIMIT, `csp-report:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`)).allowed,
});
