import { eq } from "drizzle-orm";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import {
  allowedRedirects,
  DCR_CALLBACKS,
  registrationRefusal,
} from "@dustinedwards/site-runtime/mcp-login";
import type { Db } from "~/db";
import { oauthAuthorizationCodes, oauthClients } from "~/db";
import { generateSecret } from "~/lib/auth/mcp-tokens";
import { DEMO_ACCOUNT_ID_PREFIX, OAUTH_CODE_TTL_MS } from "~/lib/constants";
import { readJson, readText } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

import {
  isMetadataDocumentClientId,
  resolveMetadataDocumentClient,
} from "./client-metadata.server";
import { mcpResource, requestsWrite } from "./metadata";
import { isAcceptableRedirectUri, isRegisteredRedirect } from "./redirects";

// The OAuth provider.
// - The access token is an ordinary fox_mcp_ key in api_keys: merchant scope, bound to one account,
//   with a one-hour expires_at. The /mcp door verifies it exactly as it verifies a key made in
//   Settings, so an OAuth caller gets the merchant tools and nothing else: the five human-only
//   actions have no tool to reach, and the admin MCP is another Worker.
// - The account is fixed at consent, from the session's active membership, and travels inside the
//   code.

export const DEFAULT_CLIENT_NAME = "OAuth Client";

const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 10;
export const MAX_FIELD = 2000;

/**
 * RFC 7636: an S256 challenge is 43 base64url characters, and a verifier 43 to 128 unreserved
 * characters.
 */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What an endpoint answers: a status and a JSON body. */
export interface OAuthResult {
  status: number;
  body: Record<string, unknown>;
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function oauthResponse(result: OAuthResult, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json", ...NO_STORE_HEADERS, ...extra },
  });
}

export function oauthError(status: number, error: string, description?: string): OAuthResult {
  return { status, body: description ? { error, error_description: description } : { error } };
}

export function plusMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The token and revoke bodies. Null when the body cannot be read. */
export async function parseOAuthBody(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await readText(request, BODY_MAX_BYTES));
  }
  if (type.includes("application/json")) {
    try {
      const body = (await readJson(request, BODY_MAX_BYTES)) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string") params.set(k, v);
      return params;
    } catch (error) {
      if (error instanceof Response) throw error;
      return null;
    }
  }
  return null;
}

/**
 * The exact callbacks a registration may name: site-runtime's DCR_CALLBACKS (Grok, ChatGPT, Gemini
 * Enterprise) and DCR_REDIRECT_URIS, as on the admin MCP (site-runtime's adminMcpWorker,
 * mcp/src/index.ts).
 */
export function registrationCallbacks(env: Pick<Env, "DCR_REDIRECT_URIS">): string {
  return [...DCR_CALLBACKS, ...allowedRedirects(env.DCR_REDIRECT_URIS)].join(",");
}

/**
 * Register a client. Registering does nothing until a signed-in merchant approves it at
 * /oauth/authorize. REGISTRATION IS KEPT ONLY FOR THE CLIENTS THAT STILL NEED IT. Every redirect
 * URI must be one of `allowed` character for character (site-runtime's registrationRefusal, the
 * check every family MCP door runs), because a redirect URI is where a code is delivered. A client
 * registered before this check keeps working: only new registrations are checked.
 */
export async function registerClient(
  db: Db,
  body: unknown,
  now: Date,
  allowed: string,
): Promise<OAuthResult> {
  if (!body || typeof body !== "object") return oauthError(400, "invalid_client_metadata");
  const raw = body as Record<string, unknown>;

  const uris = raw.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every((u) => typeof u === "string" && isAcceptableRedirectUri(u))
  ) {
    return oauthError(400, "invalid_redirect_uri");
  }
  const refused = registrationRefusal(allowed, raw);
  if (refused) return oauthError(400, "invalid_redirect_uri", refused);
  const redirectUris = uris as string[];
  const clientName = (asString(raw.client_name)?.trim() || DEFAULT_CLIENT_NAME).slice(
    0,
    MAX_CLIENT_NAME,
  );

  const id = crypto.randomUUID();
  await db.insert(oauthClients).values({ id, clientName, redirectUris, createdAt: now });

  return {
    status: 201,
    body: {
      client_id: id,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Only public clients with PKCE: no secret is issued, so "none" is the
      // one method there is, whatever the request asked for.
      token_endpoint_auth_method: "none",
    },
  };
}

export type AuthorizeCheck =
  | {
      ok: true;
      clientId: string;
      clientName: string;
      /** Every redirect URI the client registered or its document lists. */
      redirectUris: string[];
      redirectUri: string;
      state: string | null;
      codeChallenge: string;
      /** The client asked for merchant.write, so the consent page starts
       *  "Allow changes" ticked. The owner's tick decides; this never does. */
      wantsWrite: boolean;
      /** Set when the client is known from its metadata document, so the code
       *  can record it as a client row (the codes and grants name one). */
      metadataDocument: boolean;
    }
  | { ok: false; title: string; message: string };

/**
 * The consent page runs this on the way in, and the approve step runs it again on the posted
 * fields, so nothing the page carried in hidden inputs is trusted.
 */
export async function checkAuthorizeRequest(
  db: Db,
  params: URLSearchParams,
  origin: string,
): Promise<AuthorizeCheck> {
  const clientId = asString(params.get("client_id"));
  const redirectUri = asString(params.get("redirect_uri"));
  const state = asString(params.get("state"));
  const codeChallenge = asString(params.get("code_challenge"));

  if (!clientId || !redirectUri) {
    return { ok: false, title: "Invalid request", message: "Missing client_id or redirect_uri." };
  }
  if (params.get("response_type") !== "code") {
    return {
      ok: false,
      title: "Unsupported response_type",
      message: "Only response_type=code is supported.",
    };
  }
  // PKCE S256 is mandatory; plain is deprecated in OAuth 2.1.
  if (
    !codeChallenge ||
    params.get("code_challenge_method") !== "S256" ||
    !CHALLENGE_SHAPE.test(codeChallenge)
  ) {
    return {
      ok: false,
      title: "PKCE required",
      message: "This authorization server requires PKCE with code_challenge_method=S256.",
    };
  }

  // RFC 8707: the one resource this server issues tokens for is /mcp. A
  // request naming another is refused rather than handed a token that would
  // not be good there.
  const resource = asString(params.get("resource"));
  if (resource && resource !== mcpResource(origin)) {
    return {
      ok: false,
      title: "Invalid request",
      message: "This server issues access to its /mcp endpoint only.",
    };
  }

  // A client_id that is an https URL is a metadata document, fetched and
  // checked each time (the library caches what the document allows); any
  // other is one this server minted at registration.
  const metadataDocument = clientId.length <= MAX_FIELD && isMetadataDocumentClientId(clientId);
  const client = metadataDocument
    ? await resolveMetadataDocumentClient(clientId, mcpResource(origin))
    : clientId.length > MAX_FIELD
      ? undefined
      : (
          await db
            .select({
              clientName: oauthClients.clientName,
              redirectUris: oauthClients.redirectUris,
            })
            .from(oauthClients)
            .where(eq(oauthClients.id, clientId))
            .limit(1)
        )[0];
  if (!client) {
    return {
      ok: false,
      title: "Unknown client",
      message: "This client is not registered with Foxhound.",
    };
  }
  if (!isRegisteredRedirect(redirectUri, client.redirectUris)) {
    return {
      ok: false,
      title: "Invalid redirect URI",
      message: "The redirect_uri does not match any URI registered for this client.",
    };
  }
  if (state && state.length > MAX_FIELD) {
    return { ok: false, title: "Invalid request", message: "The state parameter is too long." };
  }

  return {
    ok: true,
    clientId,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    redirectUri,
    state,
    codeChallenge,
    wantsWrite: requestsWrite(params.get("scope")),
    metadataDocument,
  };
}

export interface IssueCodeInput {
  clientId: string;
  /** A metadata-document client's name and redirect URIs, recorded as its
   *  client row so the code and the grant can name it. */
  metadataDocument: { clientName: string; redirectUris: string[] } | null;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** The session's active account, resolved by the caller from the session. */
  accountId: string;
  userId: string;
  /** What the owner granted on the consent page (grantedScopes). */
  scopes: string[];
  /** This authorization server's issuer, sent back as iss (RFC 9207). */
  issuer: string;
  now: Date;
}

/**
 * Mint a single-use code for the account the person approved with, and return the URL to send their
 * browser to. Only the code's hash is stored. A demo account is refused: the /mcp door refuses demo
 * keys too, so a grant for one would be a connection that can never work.
 */
export async function issueAuthorizationCode(
  db: Db,
  input: IssueCodeInput,
): Promise<string | null> {
  if (input.accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) return null;
  const code = generateSecret();
  if (input.metadataDocument) {
    // The document is the client's own word on its name and redirect URIs, and
    // it was fetched for this request, so the row follows it.
    const row = {
      clientName: input.metadataDocument.clientName,
      redirectUris: input.metadataDocument.redirectUris,
    };
    await db
      .insert(oauthClients)
      .values({ id: input.clientId, ...row, createdAt: input.now })
      .onConflictDoUpdate({ target: oauthClients.id, set: row });
  }
  await db.insert(oauthAuthorizationCodes).values({
    id: crypto.randomUUID(),
    codeHash: await sha256Hex(code),
    clientId: input.clientId,
    accountId: input.accountId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: input.scopes,
    expiresAt: plusMs(input.now, OAUTH_CODE_TTL_MS),
    createdAt: input.now,
  });
  const target = new URL(input.redirectUri);
  target.searchParams.set("code", code);
  if (input.state) target.searchParams.set("state", input.state);
  target.searchParams.set("iss", input.issuer);
  return target.toString();
}

/** The URI was checked against the client's registration. */
export function denyRedirect(redirectUri: string, state: string | null, issuer: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", "access_denied");
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return target.toString();
}
