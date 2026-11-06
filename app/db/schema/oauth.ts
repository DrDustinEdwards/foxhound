import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, json } from "./columns";
import { accounts, apiKeys } from "./tenancy";

// ============================================================================
// OAuth provider for external agents
// ============================================================================
//
// Recova kept oauth_clients, oauth_authorization_codes and oauth_tokens in
// Supabase. Those rows do not migrate (SCHEMA.md); these three tables are
// Foxhound's own. Every secret is stored as its SHA-256 hash only: the code,
// the refresh token, and the access token, which is an ordinary fox_mcp_ key in
// api_keys so the /mcp door verifies it the way it verifies every key.

/** A client registered through RFC 7591 dynamic registration. The id is always
 *  minted here, never taken from the request. */
export const oauthClients = sqliteTable("oauth_clients", {
  id: id(),
  clientName: text("client_name").notNull(),
  redirectUris: json<string[]>("redirect_uris").notNull(),
  createdAt: ts("created_at").notNull(),
});

/** One authorization code, single use, bound at consent to the account the
 *  signed-in person had active. */
export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    id: id(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Who approved. Soft reference to Better Auth's user, as elsewhere. */
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    /** What the owner granted on the consent page. Null on a code minted before
     *  the read and write split, which grants read only. */
    scopes: json<string[]>("scopes"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("oauth_authorization_codes_code_hash_uq").on(t.codeHash),
    index("oauth_authorization_codes_account_idx").on(t.accountId),
  ],
);

/** One live connection: the refresh token and the api_keys row holding its
 *  current access token. A refresh rotates both in place, so Settings shows
 *  one key per connection. */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    /** Who approved, copied from the code. A grant is this person's
     *  delegation: it ends when they stop being an active member of the
     *  account (removeMember, account deletion, or a refresh that finds no
     *  membership). Soft reference to Better Auth's user, as on the code. */
    userId: text("user_id").notNull(),
    /** The code this grant was made from, so a replayed code can revoke it. */
    codeId: text("code_id").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    /** The refresh token this one replaced. Presenting it again is a replay,
     *  and revokes the grant. */
    previousRefreshHash: text("previous_refresh_hash"),
    refreshExpiresAt: ts("refresh_expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("oauth_grants_refresh_hash_uq").on(t.refreshHash),
    index("oauth_grants_previous_refresh_hash_idx").on(t.previousRefreshHash),
    index("oauth_grants_code_idx").on(t.codeId),
    index("oauth_grants_api_key_idx").on(t.apiKeyId),
    index("oauth_grants_account_idx").on(t.accountId),
    index("oauth_grants_user_account_idx").on(t.userId, t.accountId),
  ],
);
