import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import { apiKeys } from "~/db";
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
export async function listAccountApiKeys(db: Db, accountId: string): Promise<ApiKeyRow[]> {
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
