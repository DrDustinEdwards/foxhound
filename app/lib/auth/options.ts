import type { signInOptions } from "@dustinedwards/site-runtime/sign-in";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import { isDisposableEmail } from "./disposable-emails";

// Database-agnostic Better Auth options shared by the runtime factory
// (auth.server.ts, which adds the family sign-in from site-runtime ./sign-in and
// the D1-backed Drizzle adapter) and the CLI schema generator (generate.config.ts, which
// introspects these options to emit the auth tables). Nothing here touches a
// binding or a secret, so it is safe to import from both contexts.
//
// ARCHITECTURE.md: Better Auth on D1 owns user/session/account(singular)/
// verification. Our business `accounts`/`account_members` (plural) are separate
// and reconciled in Phase 3 C4 (see docs/auth/README.md).

/** Session lifetime: 30 days, refreshed at most once per day. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const authOptions = {
  appName: "Foxhound",
  // Foxhound's own hooks only; withSignIn merges them with the shared ones.
  databaseHooks: {
    user: {
      create: {
        // Disposable-email blocklist at account creation (legacy rule). Applies
        // to every path that mints a user (the email link, Google and Apple).
        // The code is what Better Auth puts in ?error= on its way back to the
        // errorCallbackURL (/login), as Recova's callback sent
        // /login?error=disposable_email (app/auth/callback/route.ts, blob
        // 7cb52c7b). Without one, Better Auth answers with a bare 400 instead.
        before: async (user) => {
          if (isDisposableEmail(user.email)) {
            throw new APIError("BAD_REQUEST", {
              code: "disposable_email",
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
    // session points at. It is writable only by the server-side switch action,
    // which ports legacy's validation from
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
      // The session's place and device id (`location`, `deviceId`) are
      // site-runtime's sessionDetails fields, merged in by withSignIn.
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

/** Foxhound's options over the family sign-in's (site-runtime ./sign-in). The
 *  hooks are merged, not replaced: the shared databaseHooks.account store no
 *  Google or Apple tokens (FH-5), the shared session keeps freshAge (a sign-in
 *  from the last 10 minutes to add a passkey or unlink), and the shared
 *  advanced settings read the client IP from cf-connecting-ip. */
export function withSignIn(signIn: Awaited<ReturnType<typeof signInOptions>>) {
  return {
    ...signIn,
    ...authOptions,
    databaseHooks: { ...signIn.databaseHooks, ...authOptions.databaseHooks },
    session: {
      ...signIn.session,
      ...authOptions.session,
      // sessionDetails is on (auth.server.ts), so the shared fields are there.
      additionalFields: {
        ...(signIn.session.additionalFields as NonNullable<typeof signIn.session.additionalFields>),
        ...authOptions.session.additionalFields,
      },
    },
    advanced: { ...signIn.advanced, ...authOptions.advanced },
  };
}
