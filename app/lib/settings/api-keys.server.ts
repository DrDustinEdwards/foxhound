import { and, desc, eq, exists, gt, isNull, or } from "drizzle-orm";
import { olderThan } from "@dustinedwards/site-runtime/d1";

import type { Db } from "~/db";
import { apiKeys, mcpCalls, oauthGrants } from "~/db";
import { MCP_CALLS_SHOWN, maskSecretsInText } from "~/lib/admin/mcps";
import { MCP_TOKEN_SCOPE, issueMcpToken, type IssuedMcpToken } from "~/lib/auth/mcp-tokens";

// S29's read model and its ACCOUNT-SCOPED writers. Plain account-state writes, not money writes.

export interface ApiKeyRow {
  id: string;
  label: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
}

/**
 * Admin-scoped keys carry `account_id = null` by construction in `issueMcpToken`, so they cannot
 * appear in an account-scoped list on either side.
 */
export async function listAccountApiKeys(
  db: Db,
  accountId: string,
  now: Date = new Date(),
): Promise<ApiKeyRow[]> {
  return db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.accountId, accountId),
        eq(apiKeys.scope, MCP_TOKEN_SCOPE.MERCHANT),
        isNull(apiKeys.revokedAt),
        // An OAuth connection's key expires every hour and is renewed by a refresh, so a lapsed
        // hour alone does not end it.
        or(
          isNull(apiKeys.expiresAt),
          gt(apiKeys.expiresAt, now),
          exists(
            db
              .select({ id: oauthGrants.id })
              .from(oauthGrants)
              .where(
                and(
                  eq(oauthGrants.apiKeyId, apiKeys.id),
                  isNull(oauthGrants.revokedAt),
                  gt(oauthGrants.refreshExpiresAt, now),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Issue one merchant key for this account. Settings never issues an Admin API key, whoever is
 * signed in: that is the admin area's, behind Cloudflare Access (issueAdminApiKey).
 */
export async function createAccountApiKey(
  db: Db,
  accountId: string,
  label: string,
): Promise<IssuedMcpToken> {
  return issueMcpToken(db, { accountId, scope: MCP_TOKEN_SCOPE.MERCHANT, label });
}

/** Revoke one key, pinned to the account. Returns false when the id is not on
 *  this account, so the route can refuse instead of reporting a no-op success. */
export async function revokeAccountApiKey(
  db: Db,
  accountId: string,
  keyId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!rows[0]) return false;

  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)));
  return true;
}

export interface AccountMcpCallRow {
  id: string;
  tool: string;
  outcome: string;
  /** The error the agent was given, masked for display; null when the call worked. */
  error: string | null;
  /** Null when the key is gone: the log's api_key_id outlives the key. */
  keyLabel: string | null;
  createdAt: Date;
}

/**
 * The account's own MCP calls, newest first, MCP_CALLS_SHOWN a page. Only this account's rows (rule
 * 8: accountId first), the error masked as /admin/operations masks it.
 */
export async function listAccountMcpCalls(
  db: Db,
  accountId: string,
  before?: { at: Date; id: string },
): Promise<{ calls: AccountMcpCallRow[]; more: boolean }> {
  const rows = await db
    .select({
      id: mcpCalls.id,
      tool: mcpCalls.tool,
      outcome: mcpCalls.outcome,
      error: mcpCalls.error,
      keyLabel: apiKeys.label,
      createdAt: mcpCalls.createdAt,
    })
    .from(mcpCalls)
    // The key must be this account's too, so a label is never read across accounts.
    .leftJoin(apiKeys, and(eq(apiKeys.id, mcpCalls.apiKeyId), eq(apiKeys.accountId, accountId)))
    // Keyset on (time, id), the order's own columns, so calls logged in the same millisecond are never skipped.
    .where(
      and(
        eq(mcpCalls.accountId, accountId),
        before ? olderThan(mcpCalls.createdAt, mcpCalls.id, before.at, before.id) : undefined,
      ),
    )
    .orderBy(desc(mcpCalls.createdAt), desc(mcpCalls.id))
    .limit(MCP_CALLS_SHOWN + 1);
  return {
    calls: rows
      .slice(0, MCP_CALLS_SHOWN)
      .map((row) => ({ ...row, error: row.error === null ? null : maskSecretsInText(row.error) })),
    more: rows.length > MCP_CALLS_SHOWN,
  };
}
