import type { signInOptions } from "@dustinedwards/site-runtime/sign-in";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import { isDisposableEmail } from "@dustinedwards/site-runtime/sign-in-form";

// Database-agnostic Better Auth options shared by the runtime factory (auth.server.ts) and the CLI schema generator (generate.config.ts). Nothing here touches a binding or a secret.

/** Session lifetime: 30 days, refreshed at most once per day. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const authOptions = {
  appName: "Foxhound",
  // Foxhound's own hooks only; withSignIn merges them with the shared ones.
  databaseHooks: {
    user: {
      create: {
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
    // `input: false` is the money-path half: without it a client could set the
    // field through a sign-in or sign-up payload and choose which account its
    // own session points at.
    //
    // `session` is generated from these options, so a `.references()` cannot be
    // expressed here and any hand-written one would be erased on the next
    // generate; it would also point a Better-Auth-owned table at a business
    // table.
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
    // Match the app's id convention (text uuid, crypto.randomUUID) so auth ids read like tenant ids.
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
} satisfies BetterAuthOptions;

/**
 * Foxhound's options over the family sign-in's (site-runtime ./sign-in). The
 * hooks are merged, not replaced: the shared databaseHooks.account store no
 * Google or Apple tokens, the shared session keeps freshAge (a sign-in
 * from the last 10 minutes to add a passkey or unlink), and the shared advanced
 * settings read the client IP from cf-connecting-ip.
 */
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
