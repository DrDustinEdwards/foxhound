# MCP Token Model (Phase 3 design; Phase 7 consumes)

Foxhound's MCP servers (Phase 7, `mcp.foxhoundapp.com/mcp` and `/mcp/admin`)
authenticate with bearer tokens issued from the app and tied to Better Auth
identities. Phase 3 designs and implements the token model; it does NOT build any
MCP endpoint. This document is the contract Phase 7 builds against.

## Storage

Tokens live in the existing `api_keys` table (SCHEMA.md: "api_keys -> carry
(merchant API/MCP)"). The legacy `oauth_clients` / `oauth_authorization_codes` /
`oauth_tokens` tables do NOT migrate; Better Auth plus this model replaces them.

Columns used:

| column       | use                                                        |
|--------------|------------------------------------------------------------|
| `id`         | token id (referenced for revocation, last-used stamping)   |
| `account_id` | owning account for merchant tokens; NULL for admin tokens  |
| `key_hash`   | SHA-256 hex of the plaintext token; the plaintext is never stored |
| `label`      | human label ("Zapier", "ops laptop")                       |
| `scope`      | `mcp_merchant` or `mcp_admin`                              |
| `created_at` | issuance time                                              |
| `last_used_at` | stamped on each successful verify                        |
| `revoked_at` | set on revoke; verification rejects thereafter             |

## Token format

`fox_mcp_<base64url(32 random bytes)>`

The `fox_mcp_` prefix makes a leaked token recognizable in logs/secret scans and
lets `verifyMcpToken` reject non-MCP input before any DB access. Only the SHA-256
hash is stored; the plaintext is shown to the operator exactly once at issuance.

## Scopes

- `mcp_merchant` — the merchant MCP (`/mcp`). Account-scoped: `account_id` is the
  owning account. Every data access MUST go through the Phase 2 `byAccount`
  helpers keyed on that `account_id`; a merchant token can never read another
  tenant.
- `mcp_admin` — the operator MCP (`/mcp/admin`). Platform-scoped: `account_id` is
  NULL. Not tied to a single tenant.

## Issuance (gated by Better Auth in Phase 7)

Issuance is only ever reached behind an authenticated, role-checked endpoint:

- A signed-in account **owner** issues an `mcp_merchant` token for **their own**
  account (`account_id` from their resolved membership; never a supplied value).
- A platform **admin** (`isAdminEmail`) issues an `mcp_admin` token.

Phase 3 helpers (in `app/lib/auth/mcp-tokens.ts`):

```ts
issueMcpToken(db, { accountId, scope, label? }): Promise<IssuedMcpToken>
// returns { keyId, token, scope } - `token` is plaintext, shown once
verifyMcpToken(db, presented): Promise<VerifiedMcpToken | null>
// { keyId, accountId, scope } or null (unknown / revoked / not an MCP token)
revokeMcpToken(db, keyId): Promise<void>
hashMcpToken(token): Promise<string>  // SHA-256 hex
```

## What Phase 7 builds (NOT Phase 3)

- The MCP server(s) and their `/mcp` + `/mcp/admin` HTTP surfaces.
- The bearer-token extraction from MCP requests that calls `verifyMcpToken`.
- The issuance/revocation UI (likely under settings for merchants, admin for
  operator tokens).
- Any per-tool scoping beyond the merchant/admin split.

## Security notes

- Never log the plaintext token or `key_hash` alongside identifying data.
- Verification is constant-work on a hash lookup; there is no plaintext compare.
- A merchant token's `account_id` is authoritative for tenant scoping; the MCP
  must not accept an account id from the caller.
