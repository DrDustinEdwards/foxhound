import { and, desc, eq, exists, gt, isNull, lt, or } from "drizzle-orm";

import type { Db } from "~/db";
import { apiKeys, mcpCalls, oauthGrants } from "~/db";
import { MCP_CALLS_SHOWN, maskSecretsInText } from "~/lib/admin/mcps";
import {
  MCP_TOKEN_SCOPE,
  issueMcpToken,
  type IssuedMcpToken,
  type McpTokenScope,
} from "~/lib/auth/mcp-tokens";

// S29's read model and its ACCOUNT-SCOPED writers.
//
// THE HARDENING ROWS-S SAYS IS OWED IS RIGHT HERE, and it is why this module
// exists rather than the route calling mcp-tokens directly:
// `revokeMcpToken(db, keyId)` takes NO account, so it revokes any key in the
// platform by id. That was safe while nothing but a Phase 7 admin path called
// it; the moment a merchant-facing form posts a key id, an unscoped revoke lets
// one merchant kill another merchant's integration. `revokeAccountApiKey` pins
// `account_id` in the WHERE, so a foreign id matches zero rows, as legacy's
// DELETE handler refuses one (app/api/settings/api-keys/[id]/route.ts, blob
// d0d306ba, 403 when the row's account_id is not the caller's).
//
// Plain account-state writes, not money writes.

export interface ApiKeyRow {
  id: string;
  label: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
}

/**
 * The account's LIVE merchant keys, newest first, as legacy's GET orders them
 * (`order('created_at', { ascending: false })`, blob 81e694f5).
 *
 * Revoked keys are excluded, matching legacy, whose client drops a key from the
 * list the moment the revoke succeeds and never fetches it again. Admin-scoped
 * keys carry `account_id = null` by construction in `issueMcpToken`, so they
 * cannot appear in an account-scoped list on either side.
 */
export async function listAccountApiKeys(db: Db, accountId: string, now: Date = new Date()): Promise<ApiKeyRow[]> {
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
        // An OAuth connection's key expires every hour and is renewed by a
        // refresh, so a lapsed hour alone does not end it. It is listed while
        // its access hour or its grant is live, and not once both are gone. A
        // Settings key has no expiry and is always listed.
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
 * Issue one key for this account.
 *
 * The SCOPE is decided by the caller's admin flag, never by the form alone.
 * Legacy's handler (app/api/settings/api-keys/route.ts, blob 81e694f5) checks
 * isAdminEmail too, and answers a non-admin's `scope: 'admin'` with 403; here
 * the same request gets a merchant key, which hands out nothing wider than the
 * caller already holds. `isAdmin` comes from the session.
 */
export async function createAccountApiKey(
  db: Db,
  accountId: string,
  label: string,
  wantsAdminScope: boolean,
  isAdmin: boolean,
): Promise<IssuedMcpToken> {
  const scope: McpTokenScope =
    wantsAdminScope && isAdmin ? MCP_TOKEN_SCOPE.ADMIN : MCP_TOKEN_SCOPE.MERCHANT;
  return issueMcpToken(db, { accountId, scope, label });
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
 * The account's own MCP calls, newest first, MCP_CALLS_SHOWN a page (area 11, A15 and L9: the owner sees what their
 * agents did, beside the keys they can revoke). Only this account's rows (rule 8: accountId first), the error masked as
 * /admin/operations masks it. `before` is the last row (time and id) of the page before; `more` says an older page exists.
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
        before
          ? or(lt(mcpCalls.createdAt, before.at), and(eq(mcpCalls.createdAt, before.at), lt(mcpCalls.id, before.id)))
          : undefined,
      ),
    )
    .orderBy(desc(mcpCalls.createdAt), desc(mcpCalls.id))
    .limit(MCP_CALLS_SHOWN + 1);
  return {
    calls: rows.slice(0, MCP_CALLS_SHOWN).map((row) => ({ ...row, error: row.error === null ? null : maskSecretsInText(row.error) })),
    more: rows.length > MCP_CALLS_SHOWN,
  };
}
