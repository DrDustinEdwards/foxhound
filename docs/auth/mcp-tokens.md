# MCP tokens

How callers authenticate to Foxhound's merchant MCP at `foxhoundapp.com/mcp`,
served inside the `foxhound` Worker (`workers/app.ts`). The admin MCP is a
separate Worker (`mcp/`, `admin-mcp.foxhoundapp.com`): it signs its operator in
through Cloudflare Access and reaches Foxhound only over the `AdminApi` service
binding, so it never uses these tokens.

## Storage

Every token is a row in `api_keys`. Helpers are in `app/lib/auth/mcp-tokens.ts`.

| column         | use                                                          |
|----------------|--------------------------------------------------------------|
| `id`           | token id (revocation, last-used stamping)                    |
| `account_id`   | owning account for merchant tokens; NULL for admin tokens    |
| `key_hash`     | SHA-256 hex of the plaintext; the plaintext is never stored  |
| `label`        | human label ("Zapier", "ops laptop")                         |
| `scope`        | `mcp_merchant` or `mcp_admin`                                |
| `expires_at`   | set on OAuth-issued tokens (one hour); NULL for Settings keys |
| `created_at`, `last_used_at`, `revoked_at` | lifecycle                        |

## Format

`fox_mcp_<base64url(32 random bytes)>`. The prefix makes a leaked token
recognizable in logs and secret scans and lets `verifyMcpToken` reject other
input before any DB access. The plaintext is shown once, at issuance.

## Two ways a token is issued

- **Settings, API keys** (`app/routes/app/settings/api-keys.tsx`, through
  `createAccountApiKey`): a key for the active account. The scope is merchant
  unless the session is a platform admin asking for admin scope.
- **OAuth** (`app/lib/oauth/provider.server.ts`, migration 0031): dynamic
  client registration, authorization code with PKCE S256, rotating 30-day
  refresh tokens. The access token is an ordinary merchant-scope `fox_mcp_` key
  with a one-hour `expires_at`, bound to the account chosen at consent. The
  code, refresh token and access token are all stored as hashes.

## Rules

- A merchant token's `account_id` is the tenant. No tool takes an account
  argument (CLAUDE.md hard rule 8), and every query goes through the
  account-scoped helpers.
- No tool submits a dispute, cancels, disconnects, connects, or writes an
  outcome or a bill (CLAUDE.md hard rule 4).
- Never log the plaintext token or `key_hash` beside identifying data.
