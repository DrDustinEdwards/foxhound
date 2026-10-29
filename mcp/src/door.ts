import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import {
  DCR_CALLBACKS,
  loginHandler,
  registrationLimited,
  registrationRefusal,
} from "@dustinedwards/site-runtime/mcp-login";
import type { AdminMcpEnv } from "./env";
import { adminMcpOrigin, guardMcpRequest, isFoxhoundAdmin, MCP_ROUTE, type DoorProps } from "./guard";
import { SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED } from "./scopes";
import { serveAdminMcp } from "./server";

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
//   /mcp                      the provider checks the token, then apiHandler
//                             checks its audience and hands it to server.ts
//   /authorize  /callback     the consent page and the Access sign-in
//   /register                 tightened registration (rule 13), rate limited here first
//   /token, /.well-known/*    served by the provider
//   /health                   liveness
//   anything else             404

type DoorEnv = AdminMcpEnv & { OAUTH_PROVIDER: OAuthHelpers };

const REGISTER_PATH = "/register";

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });
}

const signIn = loginHandler<DoorEnv & { PUBLIC_ORIGIN?: string }>({
  name: "Foxhound Admin",
  scopes: { read: SCOPE_READ, write: SCOPE_WRITE },
  about: `<p>It can read Foxhound. With changes allowed, it can also pause merchants, stage changes and send test emails to your own inbox.</p>
<p>It can never refund, adjust, cancel or disconnect anything. Resuming, releasing the brake, enabling a cron and billing exemption are only staged, for you to confirm in /admin/staged.</p>`,
  admit: (env, user) => isFoxhoundAdmin(env, user.email.toLowerCase()),
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
      auth?: { audience?: string; scope?: string[] };
    };
    const guarded = guardMcpRequest(adminMcpOrigin(env), { audience: auth?.audience, props, scope: auth?.scope });
    if (!guarded.ok) {
      console.warn(JSON.stringify({ door: "refused", reason: guarded.reason }));
      return text("Forbidden. This token was not issued for Foxhound Admin, or names nobody.", 403);
    }
    const response = await serveAdminMcp(request, env, { actor: guarded.email, client: guarded.client, scopes: guarded.scopes });
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(name, value);
    return out;
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

/** One request to admin-mcp.foxhoundapp.com. */
export async function adminDoor(request: Request, env: AdminMcpEnv, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === REGISTER_PATH && request.method === "POST") {
    const limited = await registrationLimited(request, env.OAUTH_KV);
    if (limited) return limited;
  }
  return providerFor(env).fetch(request, env, ctx);
}
