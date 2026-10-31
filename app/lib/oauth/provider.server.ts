import { and, eq, isNull } from "drizzle-orm";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { base64url } from "@dustinedwards/site-runtime/encoding";
import { allowedRedirects, DCR_CALLBACKS, registrationRefusal } from "@dustinedwards/site-runtime/mcp-login";

import type { Db } from "~/db";
import { findActiveMembership } from "~/lib/auth/account";
import { apiKeys, oauthAuthorizationCodes, oauthClients, oauthGrants } from "~/db";
import {
  generateSecret,
  hashMcpToken,
  MCP_TOKEN_PREFIX,
  MCP_TOKEN_SCOPE,
  mintMcpTokenValue,
} from "~/lib/auth/mcp-tokens";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_CODE_TTL_MS,
  OAUTH_REFRESH_TOKEN_TTL_MS,
} from "~/lib/constants";

import { isMetadataDocumentClientId, resolveMetadataDocumentClient } from "./client-metadata.server";
import { keyScopes, mcpResource, requestsWrite } from "./metadata";
import { isAcceptableRedirectUri, isRegisteredRedirect, redirectUriMatchesCode } from "./redirects";
import { readJson, readText } from "~/lib/http/body";

// THE OAUTH PROVIDER (J79, rows A9, F18, F19; ruling 8's build).
//
// Recova is the spec for what the flow allows: dynamic registration, the
// authorization-code grant with mandatory PKCE S256, one-hour access tokens,
// rotating 30-day refresh tokens, and revocation that never says whether a
// token was real (app/api/oauth/*, lib/oauth.ts, read whole). The engine is
// Foxhound's:
//
//   - THE ACCESS TOKEN IS AN ORDINARY fox_mcp_ KEY in api_keys, merchant scope,
//     bound to one account, with a one-hour expires_at. The /mcp door verifies
//     it exactly as it verifies a key made in Settings, so an OAuth caller gets
//     the merchant tools and nothing else: the five human-only actions have no
//     tool to reach, and the admin MCP is another Worker.
//   - THE ACCOUNT IS FIXED AT CONSENT, from the session's active membership,
//     and travels inside the code. No endpoint here reads an account from a
//     request.
//   - EVERY SECRET IS STORED AS ITS SHA-256 HASH: the code, the refresh token
//     and the access token. Recova stored all three in plain text.
//   - A REFRESH ROTATES THE GRANT'S ONE KEY ROW IN PLACE, so Settings lists one
//     key per connection and revoking it there ends the connection, which is
//     what the consent page's "You can revoke it any time from Settings"
//     promises. In Recova that sentence had nothing behind it: no settings page
//     read oauth_tokens.
//
// Plain account-state writes, not money writes. Every guarded UPDATE reads its
// RETURNING rows, because one that matches nothing is a failure to report,
// never a success.

/** Prefix on refresh tokens, so a leaked one is recognizable in a scan. */
const OAUTH_REFRESH_TOKEN_PREFIX = "fox_rt_";

/** Recova's default when a registration names no client. */
const DEFAULT_CLIENT_NAME = "OAuth Client";

const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 10;
const MAX_FIELD = 2000;

/** RFC 7636: an S256 challenge is 43 base64url characters, and a verifier 43
 *  to 128 unreserved characters. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

/** What an endpoint answers: a status and a JSON body. */
export interface OAuthResult {
  status: number;
  body: Record<string, unknown>;
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** The JSON answer every endpoint here sends. no-store with Pragma, as Recova's
 *  token route sent, because a token response must never be cached
 *  (RFC 6749 section 5.1). */
export function oauthResponse(result: OAuthResult, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json", ...NO_STORE_HEADERS, ...extra },
  });
}

function oauthError(status: number, error: string, description?: string): OAuthResult {
  return { status, body: description ? { error, error_description: description } : { error } };
}

function plusMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The token and revoke bodies. RFC 6749 section 3.2 says form-encoded; JSON is
 * accepted too because some MCP clients send it, as Recova's parseBody noted.
 * Null when the body cannot be read.
 */
export async function parseOAuthBody(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await readText(request));
  }
  if (type.includes("application/json")) {
    try {
      const body = (await readJson(request)) as Record<string, unknown>;
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

/** base64url(SHA-256(verifier)) compared to the stored challenge in time that
 *  does not depend on where they first differ. */
async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return safeEqual(base64url(digest), challenge);
}

// ============================================================================
// Registration (RFC 7591)
// ============================================================================

/**
 * The exact callbacks a registration may name: site-runtime's DCR_CALLBACKS
 * (Grok, ChatGPT, Gemini Enterprise) and DCR_REDIRECT_URIS, as on the admin
 * MCP (mcp/src/door.ts).
 */
export function registrationCallbacks(env: Pick<Env, "DCR_REDIRECT_URIS">): string {
  return [...DCR_CALLBACKS, ...allowedRedirects(env.DCR_REDIRECT_URIS)].join(",");
}

/**
 * Register a client. Registering does nothing until a signed-in merchant
 * approves it at /oauth/authorize.
 *
 * REGISTRATION IS KEPT ONLY FOR THE CLIENTS THAT STILL NEED IT (area 11, A7).
 * Claude, Claude Code and ChatGPT name a client metadata document instead.
 * Every redirect URI must be one of `allowed` character for character
 * (site-runtime's registrationRefusal, the check every family MCP door runs),
 * because a redirect URI is where a code is delivered. A client registered
 * before this check keeps working: only new registrations are checked.
 *
 * THE CLIENT ID IS ALWAYS MINTED HERE. Recova upserted on a client_id the
 * request supplied, so anyone could rewrite a registered client's redirect
 * URIs and collect the codes meant for it. A supplied client_id is ignored.
 */
export async function registerClient(db: Db, body: unknown, now: Date, allowed: string): Promise<OAuthResult> {
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
  const clientName = (asString(raw.client_name)?.trim() || DEFAULT_CLIENT_NAME).slice(0, MAX_CLIENT_NAME);

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

// ============================================================================
// Authorization (the consent page)
// ============================================================================

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
 * Check an authorization request in Recova's order with Recova's words
 * (app/oauth/authorize/page.tsx). The consent page runs this on the way in,
 * and the approve step runs it again on the posted fields, so nothing the page
 * carried in hidden inputs is trusted.
 */
export async function checkAuthorizeRequest(db: Db, params: URLSearchParams, origin: string): Promise<AuthorizeCheck> {
  const clientId = asString(params.get("client_id"));
  const redirectUri = asString(params.get("redirect_uri"));
  const state = asString(params.get("state"));
  const codeChallenge = asString(params.get("code_challenge"));

  if (!clientId || !redirectUri) {
    return { ok: false, title: "Invalid request", message: "Missing client_id or redirect_uri." };
  }
  if (params.get("response_type") !== "code") {
    return { ok: false, title: "Unsupported response_type", message: "Only response_type=code is supported." };
  }
  // PKCE S256 is mandatory; plain is deprecated in OAuth 2.1. A challenge that
  // is not the shape S256 produces is refused here too.
  if (!codeChallenge || params.get("code_challenge_method") !== "S256" || !CHALLENGE_SHAPE.test(codeChallenge)) {
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
    return { ok: false, title: "Invalid request", message: "This server issues access to its /mcp endpoint only." };
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
            .select({ clientName: oauthClients.clientName, redirectUris: oauthClients.redirectUris })
            .from(oauthClients)
            .where(eq(oauthClients.id, clientId))
            .limit(1)
        )[0];
  if (!client) {
    return { ok: false, title: "Unknown client", message: "This client is not registered with Foxhound." };
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
 * Mint a single-use code for the account the person approved with, and return
 * the URL to send their browser to. Only the code's hash is stored. A demo
 * account is refused: the /mcp door refuses demo keys too, so a grant for one
 * would be a connection that can never work.
 */
export async function issueAuthorizationCode(db: Db, input: IssueCodeInput): Promise<string | null> {
  if (input.accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) return null;
  const code = generateSecret();
  if (input.metadataDocument) {
    // The document is the client's own word on its name and redirect URIs, and
    // it was fetched for this request, so the row follows it.
    const row = { clientName: input.metadataDocument.clientName, redirectUris: input.metadataDocument.redirectUris };
    await db
      .insert(oauthClients)
      .values({ id: input.clientId, ...row, createdAt: input.now })
      .onConflictDoUpdate({ target: oauthClients.id, set: row });
  }
  await db.insert(oauthAuthorizationCodes).values({
    id: crypto.randomUUID(),
    codeHash: await hashMcpToken(code),
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

/** Deny: back to the client with access_denied, its state and iss, as Recova's
 *  deny() built it. The URI was checked against the client's registration. */
export function denyRedirect(redirectUri: string, state: string | null, issuer: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", "access_denied");
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return target.toString();
}

// ============================================================================
// Grants: issue, rotate, revoke
// ============================================================================

type GrantRow = typeof oauthGrants.$inferSelect;

/** End a grant and its key. Both guarded on not-yet-revoked, so a second call
 *  changes nothing. */
async function revokeGrant(db: Db, grant: Pick<GrantRow, "id" | "apiKeyId">, now: Date): Promise<void> {
  await db.batch([
    db
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.revokedAt))),
    db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.id, grant.apiKeyId), isNull(apiKeys.revokedAt))),
  ]);
}

function tokenBody(access: string, refresh: string, scopes: readonly string[]): Record<string, unknown> {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

async function exchangeCode(db: Db, params: URLSearchParams, now: Date): Promise<OAuthResult> {
  const code = asString(params.get("code"));
  const verifier = asString(params.get("code_verifier"));
  const clientId = asString(params.get("client_id"));
  const redirectUri = asString(params.get("redirect_uri"));
  if (!code || !verifier || !clientId) {
    return oauthError(400, "invalid_request", "Missing required parameter");
  }

  const [row] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, await hashMcpToken(code)))
    .limit(1);
  if (!row) return oauthError(400, "invalid_grant");

  // A code presented twice: OAuth 2.1 says revoke what the first use made,
  // as Recova did, since one of the two presenters is not the client.
  if (row.usedAt) {
    const made = await db
      .select({ id: oauthGrants.id, apiKeyId: oauthGrants.apiKeyId })
      .from(oauthGrants)
      .where(eq(oauthGrants.codeId, row.id));
    for (const grant of made) await revokeGrant(db, grant, now);
    return oauthError(400, "invalid_grant");
  }
  if (row.expiresAt.getTime() <= now.getTime()) return oauthError(400, "invalid_grant");
  if (row.clientId !== clientId) return oauthError(400, "invalid_grant");
  if (redirectUri && !redirectUriMatchesCode(redirectUri, row.redirectUri)) return oauthError(400, "invalid_grant");
  if (!(await verifyPkceS256(verifier, row.codeChallenge))) return oauthError(400, "invalid_grant");

  // The person who approved must still be an active member of the account.
  // Removed in the minutes since consent: the code is burnt and nothing is
  // issued.
  const stillMember = await findActiveMembership(db, row.userId, row.accountId);
  if (!stillMember) {
    await db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthAuthorizationCodes.id, row.id), isNull(oauthAuthorizationCodes.usedAt)))
      .returning({ id: oauthAuthorizationCodes.id });
    return oauthError(400, "invalid_grant");
  }

  // Claim the code before issuing anything. A concurrent redemption that loses
  // this UPDATE matches no row and is refused.
  const claimed = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthAuthorizationCodes.id, row.id), isNull(oauthAuthorizationCodes.usedAt)))
    .returning({ id: oauthAuthorizationCodes.id });
  if (claimed.length === 0) return oauthError(400, "invalid_grant");

  const [client] = await db
    .select({ clientName: oauthClients.clientName })
    .from(oauthClients)
    .where(eq(oauthClients.id, row.clientId))
    .limit(1);

  const access = mintMcpTokenValue();
  const refresh = `${OAUTH_REFRESH_TOKEN_PREFIX}${generateSecret()}`;
  const keyId = crypto.randomUUID();
  // A code minted before the read and write split carries none: read only.
  const scopes = keyScopes(row.scopes);
  await db.batch([
    db.insert(apiKeys).values({
      id: keyId,
      accountId: row.accountId,
      keyHash: await hashMcpToken(access),
      // The name the client registered, which is the name the person saw on
      // the consent page, so they can find this connection in Settings.
      label: `${client?.clientName ?? DEFAULT_CLIENT_NAME} (OAuth)`,
      scope: MCP_TOKEN_SCOPE.MERCHANT,
      scopes,
      createdAt: now,
      expiresAt: plusMs(now, OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
    }),
    db.insert(oauthGrants).values({
      id: crypto.randomUUID(),
      clientId: row.clientId,
      accountId: row.accountId,
      apiKeyId: keyId,
      userId: row.userId,
      codeId: row.id,
      refreshHash: await hashMcpToken(refresh),
      refreshExpiresAt: plusMs(now, OAUTH_REFRESH_TOKEN_TTL_MS),
      createdAt: now,
    }),
  ]);
  return { status: 200, body: tokenBody(access, refresh, scopes) };
}

async function exchangeRefresh(db: Db, params: URLSearchParams, now: Date): Promise<OAuthResult> {
  const refresh = asString(params.get("refresh_token"));
  const clientId = asString(params.get("client_id"));
  if (!refresh || !clientId) return oauthError(400, "invalid_request", "Missing required parameter");

  const presented = await hashMcpToken(refresh);
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.refreshHash, presented)).limit(1);

  if (!grant) {
    // A refresh token that has already been rotated away. Only a replay
    // presents one, so the grant it belonged to ends (OAuth 2.1 section 4.3.1).
    // Detection reaches one rotation back (previous_refresh_hash); a token
    // older than that is simply unknown and refused.
    const [replayed] = await db
      .select({ id: oauthGrants.id, apiKeyId: oauthGrants.apiKeyId })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.previousRefreshHash, presented), isNull(oauthGrants.revokedAt)))
      .limit(1);
    if (replayed) await revokeGrant(db, replayed, now);
    return oauthError(400, "invalid_grant");
  }
  if (grant.revokedAt || grant.refreshExpiresAt.getTime() <= now.getTime() || grant.clientId !== clientId) {
    return oauthError(400, "invalid_grant");
  }

  const [key] = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(eq(apiKeys.id, grant.apiKeyId))
    .limit(1);
  // Revoked in Settings: the connection is over, and a refresh must not bring
  // it back.
  if (!key || key.revokedAt) {
    await revokeGrant(db, grant, now);
    return oauthError(400, "invalid_grant");
  }
  // A grant is the approving person's delegation. Once they are no longer an
  // active member of the account, by whatever path, it ends here, so a removed
  // member's agent cannot keep refreshing its way into the account.
  if (!(await findActiveMembership(db, grant.userId, grant.accountId))) {
    await revokeGrant(db, grant, now);
    return oauthError(400, "invalid_grant");
  }

  const access = mintMcpTokenValue();
  const nextRefresh = `${OAUTH_REFRESH_TOKEN_PREFIX}${generateSecret()}`;
  const rotated = await db
    .update(oauthGrants)
    .set({
      refreshHash: await hashMcpToken(nextRefresh),
      previousRefreshHash: presented,
      refreshExpiresAt: plusMs(now, OAUTH_REFRESH_TOKEN_TTL_MS),
    })
    .where(and(eq(oauthGrants.id, grant.id), eq(oauthGrants.refreshHash, presented), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id });
  if (rotated.length === 0) return oauthError(400, "invalid_grant");

  const rekeyed = await db
    .update(apiKeys)
    .set({ keyHash: await hashMcpToken(access), expiresAt: plusMs(now, OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000) })
    .where(and(eq(apiKeys.id, key.id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (rekeyed.length === 0) {
    await revokeGrant(db, grant, now);
    return oauthError(400, "invalid_grant");
  }
  // The grant keeps what was approved: a refresh never widens it.
  return { status: 200, body: tokenBody(access, nextRefresh, keyScopes(key.scopes)) };
}

/**
 * The token endpoint. No parameter names an account: the code carries the
 * account fixed at consent, and a refresh keeps the grant's.
 */
export async function exchangeToken(db: Db, params: URLSearchParams, now: Date): Promise<OAuthResult> {
  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") return exchangeCode(db, params, now);
  if (grantType === "refresh_token") return exchangeRefresh(db, params, now);
  return oauthError(400, "unsupported_grant_type");
}

/**
 * RFC 7009 revocation. Ends the grant behind either of its tokens. The caller
 * answers 200 whatever happened, so this never says whether a token was real.
 * A key made in Settings is not ended here: it belongs to no grant, and its
 * lifecycle stays in Settings.
 */
export async function revokeOAuthToken(db: Db, token: string | null, now: Date): Promise<void> {
  if (!token || token.length > MAX_FIELD) return;
  const hash = await hashMcpToken(token);
  let grant: Pick<GrantRow, "id" | "apiKeyId"> | undefined;
  if (token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    [grant] = await db
      .select({ id: oauthGrants.id, apiKeyId: oauthGrants.apiKeyId })
      .from(oauthGrants)
      .where(eq(oauthGrants.refreshHash, hash))
      .limit(1);
  } else if (token.startsWith(MCP_TOKEN_PREFIX)) {
    [grant] = await db
      .select({ id: oauthGrants.id, apiKeyId: oauthGrants.apiKeyId })
      .from(oauthGrants)
      .innerJoin(apiKeys, eq(apiKeys.id, oauthGrants.apiKeyId))
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);
  }
  if (grant) await revokeGrant(db, grant, now);
}
