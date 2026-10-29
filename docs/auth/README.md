# Auth model (Phase 3)

Better Auth on D1: sessions, the family sign-in (passkey, emailed link, Google
and Apple), team invites, the merchant/admin role split, and RR8 middleware
guards. This is the reference for
how every authenticated route resolves identity.

## Session model

- **Better Auth on D1**, tables owned by Better Auth's own generator
  (`app/db/auth-schema.ts`: `user`, `session`, `account`, `verification`,
  `passkey`, `rate_limit`). Our
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
- The HTTP surface is mounted at `/api/auth/*` (Better Auth's default basePath),
  covering the passkey and email-link sign-ins, sign-out, the link's verify, and
  the OAuth callbacks.

## Sign-in

The family's one sign-in, from `@dustinedwards/site-runtime/sign-in`
(`signInOptions` in `app/lib/auth/auth.server.ts`). No passwords: migration 0038
deleted the old password rows.

- **Passkey first.** `/login` leads with "Sign in with a passkey" and offers
  saved passkeys in the email field's suggestions (autocomplete `webauthn`).
  The passkey belongs to `BETTER_AUTH_URL`'s host.
- **Emailed link and code** for a first sign-in or a lost device: one mail
  with a link and a six-digit code, each signing in an existing merchant or
  creating a new one, valid 15 minutes, sent by `sendSignInLinkEmail` on
  Capsomer's magic-link template. The link signs in whichever browser opens it
  (often the mail app's); the code is typed on the "link sent" screen, so the
  tab that asked signs in (`signInWithCode`, posted with `?code`). A wrong code
  counts, and after three the code is spent while the link still works. `/login` and
  `/signup` send it through Better Auth's handler
  (`app/lib/auth/sign-in-link.server.ts`) so Better Auth's limiter and the
  Turnstile check run. Turnstile is on once `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY` are both set. The link lands on `/passkey`, which offers
  a passkey and goes on.
- **Google and Apple**, each when its settings are present. Accounts are joined
  only by a signed-in person under My account's Sign-in panel, never by a
  matching email at sign-in (`disableImplicitLinking`); a refused sign-in comes
  back to `/login?error=account_not_linked`, which explains.
- The page actions spend the auth bucket (10 a minute per IP) and `/signup` the
  signup bucket (5 an hour) first (`app/lib/auth/rate-limit.server.ts`).

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
| Auth (`/login`, `/signup`, `/passkey`, `/api/auth/*`, `/auth/google`, `/auth/apple`, `/auth/google/callback`, `/logout`) | nothing (self-guard where relevant; `/passkey` -> `/login` without a session) | open | open | open |
| `/connect` | session only (self-guarded in its loader) | -> `/login` | shows setup form | n/a |
| `/invite/:token` | session only to accept | view open; accept -> `/login` | can accept (this is how they get an account) | n/a |
| Public utility (`/u/:token`, `/p/:token`, `/e/o/:token`, `/e/c/:token`) | nothing | open | open | open |
| App shell (`/console`, `/recovery/*`, `/disputes/*`, `/intelligence/*`, `/billing/*`, `/settings/*`, `/help`, `/welcome`) | session + account | -> `/login` | -> `/connect` | open |
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

## Google and Apple

- Each provider is enabled only when its settings are all set; otherwise its
  button is not rendered and `/auth/<provider>` is inert.
- CSRF is covered by Better Auth's signed OAuth **state cookie**, set on start
  and validated on callback.
- The callback is pinned to the canonical `/auth/google/callback` (ROUTES.md) via
  the provider `redirectURI`; that route forwards into the Better Auth handler.
  **Register `${BETTER_AUTH_URL}/auth/google/callback` as the redirect URI on the
  Google OAuth client.**
- Apple returns with a form POST to Better Auth's own
  `/api/auth/callback/apple`. **Register `${BETTER_AUTH_URL}/api/auth/callback/apple`
  as the return URL on the Apple Services ID**, with the site's domain.

## Environment variables

| name | kind | purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret (`wrangler secret`) | session/cookie signing key. Required in staging/production. |
| `BETTER_AUTH_URL` | var (`wrangler.jsonc`) | canonical origin for callbacks/redirects. |
| `GOOGLE_CLIENT_ID` | secret/ambient | Google OAuth client id (public value; kept ambient for typing). |
| `GOOGLE_CLIENT_SECRET` | secret (`wrangler secret`) | Google OAuth client secret. |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | secrets (`wrangler secret`) | Sign in with Apple: the Services ID, the team, and the key's id and PEM. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | var / secret | the check on the emailed link (and the estimator). |
| `ADMIN_EMAIL` | secret (`wrangler secret`) | comma-separated platform-admin allowlist. Unset => no admins. |

Never commit secret values; they live only in `wrangler secret`.

## MCP tokens

The MCP token model (issuance, scoping, storage) is designed in Phase 3 and
documented separately in [mcp-tokens.md](./mcp-tokens.md). Phase 7 consumes it.
