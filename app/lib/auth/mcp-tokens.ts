import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { apiKeys } from "~/db";

// MCP token model (Phase 3 designs it; Phase 7's Foxhound MCP consumes it).
//
// Storage: the existing `api_keys` table (SCHEMA.md: "api_keys -> carry (merchant
// API/MCP)"; the legacy oauth_clients/codes/tokens do NOT migrate). No new table.
//
// Model:
//   - A token is a high-entropy secret shown to the operator exactly once. Only
//     its SHA-256 hash is stored (api_keys.key_hash); the plaintext is never
//     persisted or logged.
//   - Scope lives in api_keys.scope and pins the token to one of two surfaces:
//       mcp_merchant -> merchant MCP (/mcp), account-scoped: api_keys.account_id
//                       is the owning account; every query MUST go through the
//                       byAccount helpers keyed on it.
//       mcp_admin    -> an Admin API key, platform-scoped: account_id is null;
//                       not tied to any single tenant. The admin MCP Worker
//                       signs in through Access and does not use these.
//   - Issuance: Settings, API keys (createAccountApiKey) and the OAuth provider
//     (app/lib/oauth/provider.server.ts). See docs/auth/mcp-tokens.md.
//   - Revocation is a timestamp (api_keys.revoked_at); verification rejects it.
//   - Expiry (J79): api_keys.expires_at is null for a key made in Settings and
//     set on the one-hour access token an OAuth grant issues (app/lib/oauth);
//     verification rejects a key once it has passed.

export const MCP_TOKEN_SCOPE = {
  MERCHANT: "mcp_merchant",
  ADMIN: "mcp_admin",
} as const;
export type McpTokenScope = (typeof MCP_TOKEN_SCOPE)[keyof typeof MCP_TOKEN_SCOPE];

/** Identifying prefix so a leaked token is recognizable and greppable in scans. */
export const MCP_TOKEN_PREFIX = "fox_mcp_";

/** SHA-256 hex of the presented token; only this is stored. */
export async function hashMcpToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A fresh 32-byte secret, base64url without padding (43 characters). The
 *  OAuth provider (J79) mints its codes and refresh tokens the same way. */
export function generateSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  // base64url, no padding.
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface IssueMcpTokenInput {
  /** Owning account for merchant scope; ignored (null) for admin scope. */
  accountId: string | null;
  scope: McpTokenScope;
  label?: string;
}

export interface IssuedMcpToken {
  keyId: string;
  /** Plaintext token, returned once. Never stored; show to the operator once. */
  token: string;
  scope: McpTokenScope;
}

/** A new plaintext MCP token: the prefix and a fresh secret. Only its hash
 *  is ever stored. */
export function mintMcpTokenValue(): string {
  return `${MCP_TOKEN_PREFIX}${generateSecret()}`;
}

/**
 * Issue an MCP token: generate the secret, store only its hash + scope, return
 * the plaintext once. This is the C6 issuance helper; Phase 7 calls it behind an
 * authenticated, role-checked endpoint.
 */
export async function issueMcpToken(
  db: Db,
  input: IssueMcpTokenInput,
): Promise<IssuedMcpToken> {
  const token = mintMcpTokenValue();
  const keyHash = await hashMcpToken(token);
  const keyId = crypto.randomUUID();
  const accountId = input.scope === MCP_TOKEN_SCOPE.ADMIN ? null : input.accountId;

  await db.insert(apiKeys).values({
    id: keyId,
    accountId,
    keyHash,
    label: input.label ?? null,
    scope: input.scope,
    createdAt: new Date(),
  });
  return { keyId, token, scope: input.scope };
}

export interface VerifiedMcpToken {
  keyId: string;
  accountId: string | null;
  scope: McpTokenScope;
}

/**
 * Resolve a presented token to its scope + account, or null if unknown, revoked,
 * or not an MCP token. Stamps last_used_at. Phase 7's MCP request handler calls
 * this; Phase 3 defines it as part of the model.
 */
export async function verifyMcpToken(
  db: Db,
  presented: string,
): Promise<VerifiedMcpToken | null> {
  if (!presented.startsWith(MCP_TOKEN_PREFIX)) return null;

  const keyHash = await hashMcpToken(presented);
  const rows = await db
    .select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      scope: apiKeys.scope,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt) return null;
  // An OAuth access token carries an expiry (J79); a key made in Settings does
  // not, and lives until it is revoked.
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.scope !== MCP_TOKEN_SCOPE.MERCHANT && row.scope !== MCP_TOKEN_SCOPE.ADMIN) {
    return null;
  }

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return { keyId: row.id, accountId: row.accountId, scope: row.scope };
}
