import { and, eq, isNull } from "drizzle-orm";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { base64url, sha256, sha256Hex } from "@dustinedwards/site-runtime/encoding";
import type { Db } from "~/db";
import { findActiveMembership } from "~/lib/auth/account";
import { apiKeys, oauthAuthorizationCodes, oauthClients, oauthGrants } from "~/db";
import {
  generateSecret,
  MCP_TOKEN_PREFIX,
  MCP_TOKEN_SCOPE,
  mintMcpTokenValue,
} from "~/lib/auth/mcp-tokens";
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TOKEN_TTL_MS } from "~/lib/constants";

import { keyScopes } from "./metadata";
import { redirectUriMatchesCode } from "./redirects";
import {
  oauthError,
  plusMs,
  asString,
  DEFAULT_CLIENT_NAME,
  MAX_FIELD,
  type OAuthResult,
} from "./provider.server";

/** Prefix on refresh tokens, so a leaked one is recognizable in a scan. */
const OAUTH_REFRESH_TOKEN_PREFIX = "fox_rt_";

const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

/** base64url(SHA-256(verifier)) compared to the stored challenge in time that
 *  does not depend on where they first differ. */
async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  return safeEqual(base64url(await sha256(verifier)), challenge);
}

type GrantRow = typeof oauthGrants.$inferSelect;

/** End a grant and its key. Both guarded on not-yet-revoked, so a second call
 *  changes nothing. */
async function revokeGrant(
  db: Db,
  grant: Pick<GrantRow, "id" | "apiKeyId">,
  now: Date,
): Promise<void> {
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

function tokenBody(
  access: string,
  refresh: string,
  scopes: readonly string[],
): Record<string, unknown> {
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
    .where(eq(oauthAuthorizationCodes.codeHash, await sha256Hex(code)))
    .limit(1);
  if (!row) return oauthError(400, "invalid_grant");

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
  if (!redirectUri || !redirectUriMatchesCode(redirectUri, row.redirectUri))
    return oauthError(400, "invalid_grant");
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
      keyHash: await sha256Hex(access),
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
      refreshHash: await sha256Hex(refresh),
      refreshExpiresAt: plusMs(now, OAUTH_REFRESH_TOKEN_TTL_MS),
      createdAt: now,
    }),
  ]);
  return { status: 200, body: tokenBody(access, refresh, scopes) };
}

async function exchangeRefresh(db: Db, params: URLSearchParams, now: Date): Promise<OAuthResult> {
  const refresh = asString(params.get("refresh_token"));
  const clientId = asString(params.get("client_id"));
  if (!refresh || !clientId)
    return oauthError(400, "invalid_request", "Missing required parameter");

  const presented = await sha256Hex(refresh);
  const [grant] = await db
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.refreshHash, presented))
    .limit(1);

  if (!grant) {
    // A refresh token that has already been rotated away. Only a replay presents one, so the grant
    // it belonged to ends (OAuth 2.1 section 4.3.1). Detection reaches one rotation back
    // (previous_refresh_hash); a token older than that is simply unknown and refused.
    const [replayed] = await db
      .select({ id: oauthGrants.id, apiKeyId: oauthGrants.apiKeyId })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.previousRefreshHash, presented), isNull(oauthGrants.revokedAt)))
      .limit(1);
    if (replayed) await revokeGrant(db, replayed, now);
    return oauthError(400, "invalid_grant");
  }
  if (
    grant.revokedAt ||
    grant.refreshExpiresAt.getTime() <= now.getTime() ||
    grant.clientId !== clientId
  ) {
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
  // A grant is the approving person's delegation.
  if (!(await findActiveMembership(db, grant.userId, grant.accountId))) {
    await revokeGrant(db, grant, now);
    return oauthError(400, "invalid_grant");
  }

  const access = mintMcpTokenValue();
  const nextRefresh = `${OAUTH_REFRESH_TOKEN_PREFIX}${generateSecret()}`;
  const rotated = await db
    .update(oauthGrants)
    .set({
      refreshHash: await sha256Hex(nextRefresh),
      previousRefreshHash: presented,
      refreshExpiresAt: plusMs(now, OAUTH_REFRESH_TOKEN_TTL_MS),
    })
    .where(
      and(
        eq(oauthGrants.id, grant.id),
        eq(oauthGrants.refreshHash, presented),
        isNull(oauthGrants.revokedAt),
      ),
    )
    .returning({ id: oauthGrants.id });
  if (rotated.length === 0) return oauthError(400, "invalid_grant");

  const rekeyed = await db
    .update(apiKeys)
    .set({
      keyHash: await sha256Hex(access),
      expiresAt: plusMs(now, OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
    })
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
export async function exchangeToken(
  db: Db,
  params: URLSearchParams,
  now: Date,
): Promise<OAuthResult> {
  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") return exchangeCode(db, params, now);
  if (grantType === "refresh_token") return exchangeRefresh(db, params, now);
  return oauthError(400, "unsupported_grant_type");
}

/**
 * RFC 7009 revocation. Ends the grant behind either of its tokens. The caller answers 200 whatever
 * happened, so this never says whether a token was real.
 */
export async function revokeOAuthToken(db: Db, token: string | null, now: Date): Promise<void> {
  if (!token || token.length > MAX_FIELD) return;
  const hash = await sha256Hex(token);
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
