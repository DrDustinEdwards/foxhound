import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import { isDisposableEmail } from "./disposable-emails";
import { MIN_PASSWORD_LENGTH } from "./password-policy";

export { MIN_PASSWORD_LENGTH };

// Database-agnostic Better Auth options shared by the runtime factory
// (auth.server.ts, which injects the D1-backed Drizzle adapter and env-gated
// social providers) and the CLI schema generator (generate.config.ts, which
// introspects these options to emit the auth tables). Nothing here touches a
// binding or a secret, so it is safe to import from both contexts.
//
// ARCHITECTURE.md: Better Auth on D1 owns user/session/account(singular)/
// verification. Our business `accounts`/`account_members` (plural) are separate
// and reconciled in Phase 3 C4 (see docs/auth/README.md).

/** Session lifetime: 30 days, refreshed at most once per day. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * How long a password reset link works: one hour. This is Better Auth's own
 * default (3600 seconds in better-auth's api/routes/password.mjs), set here
 * explicitly so the reset email's "expires in 1 hour" is read from the same
 * number Better Auth uses, rather than from a comment that could drift (J82).
 */
export const PASSWORD_RESET_EXPIRES_IN_SECONDS = 60 * 60;

export const authOptions = {
  appName: "Foxhound",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    autoSignIn: false,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_EXPIRES_IN_SECONDS,
    // sendResetPassword is injected by the runtime factory (auth.server.ts), which
    // has `env` and routes through the one EMAIL-binding send module. Absent here
    // because this static config is shared with the CLI schema generator (no env).
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    // sendVerificationEmail is injected by the runtime factory (see above).
  },
  databaseHooks: {
    user: {
      create: {
        // Disposable-email blocklist at account creation (legacy rule). Applies
        // to every path that mints a user (email/password and OAuth).
        before: async (user) => {
          if (isDisposableEmail(user.email)) {
            throw new APIError("BAD_REQUEST", {
              message: "Disposable email addresses are not allowed.",
            });
          }
        },
      },
    },
  },
  session: {
    // Sessions live in the D1 session table (strong consistency -> immediate
    // revocation). KV secondaryStorage was rejected: KV is eventually
    // consistent (~60s propagation), which would delay logout on a money app.
    // See docs/auth/README.md.
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
    // WHICH business account this session is currently looking at (ruling 326,
    // phase (a)). Declared HERE rather than hand-added to app/db/auth-schema.ts
    // because Better Auth owns that file and regenerates it; a hand-added column
    // would survive exactly until the next `npm run auth:generate`. Declaring it
    // as an additionalField is also what makes Better Auth's own session reads
    // and writes carry the value instead of stripping it.
    //
    // Legacy keeps this marker in an `active_account_id` COOKIE
    // (lib/account.ts:130-137, app/api/account/switch/route.ts:32). Foxhound puts
    // it on the session ROW instead: server-authoritative on a money path, it
    // dies with the session, and it needs no cross-device reconciliation. Class
    // (a) internals divergence, ruled at 326 item 5.
    //
    // `input: false` is the money-path half: without it a client could set the
    // field through a sign-in or sign-up payload and choose which account its own
    // session points at. It is writable only by the server-side switch action
    // (phase (b)), which ports legacy's validation from
    // app/api/account/switch/route.ts:18-28: the target must be an account the
    // caller ACTIVELY holds, or the switch is refused.
    //
    // NO FOREIGN KEY to accounts.id, deliberately, and this is the reason rather
    // than an omission. `session` is generated from these options, so a
    // `.references()` cannot be expressed here and any hand-written one would be
    // erased on the next generate; it would also point a Better-Auth-owned table
    // at a business table. ON DELETE SET NULL is not lost, because a dangling
    // marker is not trusted anyway: resolveActiveMembership re-checks on every
    // read that the marked account is one the user still actively holds, and
    // falls back to the earliest membership otherwise. That check is STRICTLY
    // STRONGER than the FK, since it also catches a marker pointing at an account
    // that still exists but whose membership was revoked.
    additionalFields: {
      activeAccountId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  advanced: {
    // Match the app's id convention (text uuid, crypto.randomUUID) used across
    // the Phase 2 schema so auth ids read the same as tenant ids.
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
} satisfies BetterAuthOptions;
