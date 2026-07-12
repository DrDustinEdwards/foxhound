# PENDING-BUILD-NOTES

Confirmed gotchas from Claude Code sessions, staged here to be folded into the
Capsid `foxhound-build-notes.md` (namespace recova) by Dustin / the next phase.

## Phase 3 (auth and accounts, Better Auth on D1)

1. **Better Auth CLI is versioned + named separately.** `better-auth` is
   1.6.x but `@better-auth/cli` publishes as 1.4.x, and its bin is `better-auth`
   (not `better-auth-cli`). Schema generation: `npm run auth:generate` (loads
   `app/lib/auth/generate.config.ts`, which builds a static instance with a
   placeholder adapter db purely for introspection), then `npm run db:generate`
   to produce the Drizzle migration. `drizzle.config.ts` reads BOTH
   `app/db/schema.ts` and the generated `app/db/auth-schema.ts`.

2. **Better Auth default tables do not collide with ours.** Better Auth owns
   `user` / `session` / `account` / `verification` (singular). Our business
   tables are `accounts` / `account_members` (plural). Migration 0002 creates
   only the four auth tables and touches nothing else. This is exactly what
   `schema.ts` lines 12-13 anticipated; no Phase 2 rename was needed.

3. **RR8 middleware is stable (no future flag) and the `middleware` export is
   server-only.** Route modules expose `middleware` (server; runs on SSR AND on
   client-navigation data requests, where the Cloudflare `env` is available via
   `cloudflareContext`) and a separate `clientMiddleware`. Guards use `middleware`
   and read/write `RouterContextProvider` (build-notes #2), never a plain object.
   Short-circuit by throwing a `Response` (redirect or 404).

4. **Google OAuth callback is pinned to the ROUTES.md path via `redirectURI`.**
   Better Auth's native callback is `/api/auth/callback/google`; we set the
   provider `redirectURI` to `${BETTER_AUTH_URL}/auth/google/callback` and forward
   that route into the Better Auth handler (rewriting the pathname). Register
   `${BETTER_AUTH_URL}/auth/google/callback` on the Google client.

5. **vitest needs the `~` alias mirrored.** `vitest.config.ts` sets
   `resolve.alias["~"] -> ./app`; vitest does not read tsconfig `paths`
   automatically. Any test importing app modules depends on this.

6. **Sessions are on the D1 `session` table, not KV.** KV's ~60s eventual
   consistency would delay logout/revocation; D1 is strongly consistent. See
   docs/auth/README.md.

7. **Agent-initiated `wrangler secret put` is blocked in auto mode.** The
   classifier denies secret-store writes the agent chose (not named by the user),
   so `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, and `ADMIN_EMAIL` must be set
   by Dustin. Staging/production auth verification is gated on those being set.
