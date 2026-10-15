import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import { accessSaas, authorizationUrl, finishSignIn, newSignIn } from "./access-login";
import type { AdminMcpEnv } from "./env";
import { adminMcpOrigin, guardMcpRequest, isFoxhoundAdmin, MCP_ROUTE, type DoorProps } from "./guard";
import { allowedRedirects, checkRegistration, REGISTER_PATH, registrationLimited } from "./registration";
import { grantScopes, SCOPE_WRITE, SCOPES_SUPPORTED } from "./scopes";
import { serveAdminMcp } from "./server";

// THE FOXHOUND ADMIN MCP DOOR, everything on admin-mcp.foxhoundapp.com
// (job_21de68b30fc2; MCP ruling 2026-10-10, rules 9, 12 and 13).
//
// This Worker is an OAuth 2.1 authorization server of its own
// (@cloudflare/workers-oauth-provider): CIMD for Claude, Claude Code and
// ChatGPT, a tightened registration for Grok and Gemini (registration.ts), and
// the person signs in upstream through Cloudflare Access for SaaS
// (access-login.ts), as Carrel's AI door does.
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
//   /register                 tightened registration, rate limited here first
//   /token, /.well-known/*    served by the provider
//   /health                   liveness
//   anything else             404

type DoorEnv = AdminMcpEnv & { OAUTH_PROVIDER: OAuthHelpers };

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function text(body: string, status: number, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "text/plain; charset=utf-8");
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.set(name, value);
  return new Response(body, { status, headers: out });
}

function redirect(location: string, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set("Location", location);
  out.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: out });
}

function redirectError(request: AuthRequest, description: string, headers?: Headers): Response {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", description);
  url.searchParams.set("state", request.state);
  if (request.issuer) url.searchParams.set("iss", request.issuer);
  return redirect(url.href, headers);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function clientLabel(client: ClientInfo | null, clientId: string): string {
  const name = client?.clientName?.trim();
  if (name) return name.slice(0, 100);
  try {
    return new URL(clientId).hostname;
  } catch {
    return "an unnamed AI client";
  }
}

/** The consent page, for every authorization of every client. */
function consentPage(client: ClientInfo | null, request: AuthRequest, handle: string): string {
  const name = escape(clientLabel(client, request.clientId));
  const redirectHost = new URL(request.redirectUri).hostname;
  const publisher = request.clientId.startsWith("https://")
    ? `Published by <strong>${escape(new URL(request.clientId).hostname)}</strong>.`
    : "This app registered itself, so its name is its own claim, not checked.";
  const writes = grantScopes(request.scope).includes(SCOPE_WRITE);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Allow ${name} to use Foxhound Admin?</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; line-height: 1.3; }
  button { font: inherit; padding: .55rem 1.1rem; border-radius: .35rem; cursor: pointer; margin-right: .5rem; }
</style>
</head><body>
<h1>Allow ${name} to use Foxhound Admin as you?</h1>
<p>${publisher} Its access will be sent to <strong>${escape(redirectHost)}</strong>.</p>
<p>${
    writes
      ? "It asks to read Foxhound, to pause merchants and stage changes, and to send test emails to your own inbox. You can allow reading only."
      : "It asks to read Foxhound only."
  }</p>
<p>It can never refund, adjust, cancel or disconnect anything. Resuming, releasing the brake, enabling a cron, billing exemption and plan grants are only staged, for you to confirm in /admin/staged.</p>
<p>Next you sign in with Cloudflare Access. Only Foxhound admins are let in.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Continue to sign in</button>
  ${writes ? '<button name="decision" value="read-only">Allow reading only</button>' : ""}
  <button name="decision" value="deny">Deny</button>
</form>
</body></html>`;
}

async function authorizeGet(request: Request, env: DoorEnv): Promise<Response> {
  if (!accessSaas(env)) return text("Foxhound Admin is not configured for sign-in. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return text("Unknown OAuth client.", 400);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Cache-Control", "no-store, no-transform");
  return new Response(consentPage(client, authRequest, consent.handle), { headers: consent.headers });
}

async function authorizePost(request: Request, env: DoorEnv): Promise<Response> {
  const saas = accessSaas(env);
  if (!saas) return text("Foxhound Admin is not configured for sign-in. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "read-only") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const consented = await oauth.approveConsent(request, handle);
  const approved = {
    ...consented,
    request: { ...consented.request, scope: grantScopes(consented.request.scope, { readOnly: decision === "read-only" }) },
  };
  const signIn = newSignIn();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: signIn, headers: approved.headers });
  return redirect(
    await authorizationUrl(saas, { redirectUri: `${adminMcpOrigin(env)}/callback`, state, ...signIn }),
    headers,
  );
}

async function callback(request: Request, env: DoorEnv): Promise<Response> {
  const saas = accessSaas(env);
  if (!saas) return text("Foxhound Admin is not configured for sign-in. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; nonce: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) return redirectError(original, "Sign-in with Cloudflare Access did not complete.", headers);

  const signedIn = await finishSignIn(saas, {
    code,
    redirectUri: `${adminMcpOrigin(env)}/callback`,
    verifier: data.verifier,
    nonce: data.nonce,
  });
  if (!signedIn.ok) {
    console.warn(JSON.stringify({ door: "sign-in-refused", reason: signedIn.reason }));
    return redirectError(original, "Foxhound Admin could not verify the sign-in.", headers);
  }
  if (!(await isFoxhoundAdmin(env, signedIn.email))) {
    console.warn(JSON.stringify({ door: "refused", reason: "not-an-admin" }));
    return redirectError(original, "This person is not a Foxhound admin.", headers);
  }

  const client = clientLabel(await oauth.lookupClient(original.clientId).catch(() => null), original.clientId);
  const props: DoorProps = { email: signedIn.email, client, clientId: original.clientId };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: signedIn.email,
    metadata: { client },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

const loginHandler = {
  async fetch(request: Request, env: DoorEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") return text("ok", 200);
      if (pathname === "/authorize" && request.method === "GET") return await authorizeGet(request, env);
      if (pathname === "/authorize" && request.method === "POST") return await authorizePost(request, env);
      if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
      return text("Not found.", 404);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectUri) {
        const url = new URL(error.redirectUri);
        url.searchParams.set("error", error.code);
        url.searchParams.set("error_description", error.description);
        if (error.state) url.searchParams.set("state", error.state);
        if (error.issuer) url.searchParams.set("iss", error.issuer);
        return redirect(url.href);
      }
      if (error instanceof AuthorizationError) return text(`${error.description} Start the sign-in again from your MCP client.`, 400);
      if (error instanceof CimdFetchError) return text("This app could not be verified: its client metadata document could not be fetched.", 400);
      throw error;
    }
  },
};

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
  const allowed = allowedRedirects(env);
  const key = `${origin} ${[...allowed].join(" ")}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new OAuthProvider<AdminMcpEnv>({
      apiRoute: MCP_ROUTE,
      apiHandler: apiHandler as unknown as ExportedHandlerWithFetch<AdminMcpEnv>,
      defaultHandler: loginHandler as unknown as ExportedHandlerWithFetch<AdminMcpEnv>,
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
      clientRegistrationCallback: ({ clientMetadata }) => checkRegistration(allowed, clientMetadata),
    });
    providers.set(key, provider);
  }
  return provider;
}

/** One request to admin-mcp.foxhoundapp.com. */
export async function adminDoor(request: Request, env: AdminMcpEnv, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === REGISTER_PATH && request.method === "POST") {
    const limited = await registrationLimited(request, env);
    if (limited) return limited;
  }
  return providerFor(env).fetch(request, env, ctx);
}
