import type { BetterAuthOptions } from "better-auth";

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
    // actual send through a seam (auth.server.ts) that logs the link on staging.
    requireEmailVerification: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    autoSignIn: false,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
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
