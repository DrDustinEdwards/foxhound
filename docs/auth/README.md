# Auth model (Phase 3)

Better Auth on D1: sessions, email/password, Google OAuth, team invites, the
merchant/admin role split, and RR8 middleware guards. This is the reference for
how every authenticated route resolves identity.

## Session model

- **Better Auth on D1**, tables owned by Better Auth's own generator
  (`app/db/auth-schema.ts`: `user`, `session`, `account`, `verification`). Our
  business tables (`accounts`, `account_members`) are separate; the names do not
  collide (singular vs plural). Regenerate the auth tables with
  `npm run auth:generate` then `npm run db:generate`.
- **Sessions live in the D1 `session` table, not KV.** KV is eventually
  consistent (writes propagate up to ~60s), which would delay logout/revocation.
  D1 is strongly consistent, so a sign-out is effective immediately. At this
  scale (~300 merchants) per-request session reads on D1 are negligible. This is
  the deliberate "Cloudflare-appropriate" choice for a money app.
- Session cookie is HTTP-only and signed with `BETTER_AUTH_SECRET`. Lifetime 30
  days, refreshed at most daily (`app/lib/auth/options.ts`).
- Email verification is required; auto-sign-in is off. Password minimum 12 chars.
- The HTTP surface is mounted at `/api/auth/*` (Better Auth's default basePath),
  covering sign-in/up/out, verify-email, reset-password, and OAuth callbacks.

## Two role axes (kept separate)

- **Platform role** - admin vs merchant. Derived from the `ADMIN_EMAIL`
  allowlist (`isAdminEmail`), not stored per account. Governs `/admin/*`.
- **Account role** - owner vs member, stored on `account_members.role`. Governs
  team permissions within one merchant account (only owners invite).

## Guard matrix (route tree -> requirement)

Guards are RR8 **server** middleware (`app/lib/auth/guards.ts`), attached to the
app-shell layout and a pathless admin-guard layout.

| Route tree | Requires | Unauthenticated | Authed, no account | Authed, non-admin |
|---|---|---|---|---|
| Marketing (`/`, `/pricing`, `/products/*`, `/audit`, `/blog/*`, `/docs/*`, `/demos`, `/privacy`, `/terms`, file routes) | nothing | open | open | open |
| Auth (`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/api/auth/*`, `/auth/google`, `/auth/google/callback`, `/logout`) | nothing (self-guard where relevant) | open | open | open |
| `/connect` | session only (self-guarded in its loader) | -> `/login` | shows setup form | n/a |
| `/invite/:token` | session only to accept | view open; accept -> `/login` | can accept (this is how they get an account) | n/a |
| Public utility (`/u/:token`, `/p/:token`, `/e/o/:token`, `/e/c/:token`) | nothing | open | open | open |
| App shell (`/dashboard`, `/recovery/*`, `/disputes/*`, `/intelligence/*`, `/billing/*`, `/settings/*`, `/help`, `/welcome`) | session + account | -> `/login` | -> `/connect` | open |
| Admin (`/admin/*`) | session + account + admin role | -> `/login` | -> `/connect` | **404** (not 403; existence hiding) |

The app-shell middleware publishes the caller's identity, membership, and admin
flag on `authContext`; app loaders/actions read it instead of re-querying.

## Account-resolution flow

1. `getSession(env, request)` -> the Better Auth user (or null -> `/login`).
2. `resolveMembership(db, userId)` -> the user's active `account_members` row
   joined to its account, or null.
3. Null membership -> redirect to `/connect`, where the account is created.
4. `createAccountForUser` writes the `accounts` row + the owner `account_members`
   row as one atomic D1 batch (not a money write; batch is just the atomicity
   primitive). An idempotency guard prevents a second account per user.

Single account per user (legacy model); multi-account switching is out of scope.

## Invite flow

1. An account **owner** at `/settings/team` submits an email. `createInvite`
   inserts a pending `account_members` row with a random `invite_token` and a
   7-day expiry, and returns the `/invite/:token` link.
2. The invitee opens the link. If not signed in, they authenticate with the
   invited email first. `acceptInvite` requires the session user's email to match
   the invited email (invites are not transferable), then sets `user_id`,
   flips status to active, and clears the token.
3. Expired or already-accepted tokens are treated as invalid.

Phase 4 also emails the invite link through the send module; Phase 5 builds the
full team UI. Phase 3 seeds the create + accept paths.

## Google OAuth

- Provider is enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
  both set; otherwise the "Continue with Google" button is not rendered and the
  path is inert (clean stub).
- CSRF is covered by Better Auth's signed OAuth **state cookie**, set on start
  and validated on callback.
- The callback is pinned to the canonical `/auth/google/callback` (ROUTES.md) via
  the provider `redirectURI`; that route forwards into the Better Auth handler.
  **Register `${BETTER_AUTH_URL}/auth/google/callback` as the redirect URI on the
  Google OAuth client.**

## Environment variables

| name | kind | purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret (`wrangler secret`) | session/cookie signing key. Required in staging/production. |
| `BETTER_AUTH_URL` | var (`wrangler.jsonc`) | canonical origin for callbacks/redirects. |
| `GOOGLE_CLIENT_ID` | secret/ambient | Google OAuth client id (public value; kept ambient for typing). |
| `GOOGLE_CLIENT_SECRET` | secret (`wrangler secret`) | Google OAuth client secret. |
| `ADMIN_EMAIL` | secret (`wrangler secret`) | comma-separated platform-admin allowlist. Unset => no admins. |

Never commit secret values; they live only in `wrangler secret`.

## MCP tokens

The MCP token model (issuance, scoping, storage) is designed in Phase 3 and
documented separately in [mcp-tokens.md](./mcp-tokens.md). Phase 7 consumes it.
