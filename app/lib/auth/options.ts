import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import { isDisposableEmail } from "./disposable-emails";
import { sendAuthEmail } from "./send-auth-email";

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

/** Minimum password length at signup (legacy parity: strong-by-default). */
export const MIN_PASSWORD_LENGTH = 12;

export const authOptions = {
  appName: "Foxhound",
  emailAndPassword: {
    enabled: true,
    // Email deliverability + the real send path are Phase 4 (thin send module
    // on the EMAIL binding). Phase 3 keeps verification required and routes the
    // actual send through the send-auth-email seam that logs the link on staging.
    requireEmailVerification: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    autoSignIn: false,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail("password-reset", user.email, url);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail("email-verification", user.email, url);
    },
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
  },
  advanced: {
    // Match the app's id convention (text uuid, crypto.randomUUID) used across
    // the Phase 2 schema so auth ids read the same as tenant ids.
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
} satisfies BetterAuthOptions;
