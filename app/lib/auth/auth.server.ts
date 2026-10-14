import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "~/db/client";
import * as authSchema from "~/db/auth-schema";

import { authOptions } from "./options";
import { sendAuthEmail, sendPasswordResetEmail } from "./send-auth-email";

// Runtime Better Auth factory. Built per-request from the Cloudflare `env` so it
// binds the D1-backed Drizzle adapter (binding `DB`) and only enables social
// providers whose secrets are present. The CLI schema generator uses a separate
// static instance (generate.config.ts); this file is the one application code
// imports.
//
// Env inputs (see env.d.ts / docs/auth/README.md):
//   BETTER_AUTH_SECRET   secret  - signing key (required in real environments)
//   BETTER_AUTH_URL      var     - canonical origin for callbacks/redirects
//   GOOGLE_CLIENT_ID     var     - enables Google OAuth when paired with secret
//   GOOGLE_CLIENT_SECRET secret  - Google OAuth (C3); provider gated on presence

function buildAuth(env: Env) {
  const db = getDb(env);

  // Google provider is wired only when both halves of the credential exist, so
  // the app runs identically with or without a configured dev client (C3).
  const googleId = env.GOOGLE_CLIENT_ID;
  const googleSecret = env.GOOGLE_CLIENT_SECRET;
  const socialProviders =
    googleId && googleSecret
      ? {
          google: {
            clientId: googleId,
            clientSecret: googleSecret,
            // Pin the callback to the canonical ROUTES.md path (/auth/google/
            // callback) instead of Better Auth's default /api/auth/callback/
            // google. That route forwards into the Better Auth handler, so the
            // redirect_uri sent to Google, the token exchange, and the CSRF
            // state cookie validation all agree. This is the URI Dustin
            // registers on the Google OAuth client.
            redirectURI: env.BETTER_AUTH_URL
              ? `${env.BETTER_AUTH_URL}/auth/google/callback`
              : undefined,
          },
        }
      : undefined;

  return betterAuth({
    ...authOptions,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    // Inject the token-bearing auth emails here, where `env` is available, so they
    // route through the one EMAIL-binding send module (never logged).
    emailAndPassword: {
      ...authOptions.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        const sent = await sendPasswordResetEmail(env, user.email, url);
        // A refused send is thrown by name so it is not silent (J82). Better
        // Auth runs this hook through runInBackgroundOrAwait, which catches the
        // throw and logs it, and answers the form the same way whether or not a
        // mail went out (it never says whether an address exists). The message
        // carries the reason and the provider's words with the link cut out,
        // never the link.
        if (sent.status !== "sent") {
          throw new Error(
            `password reset email not sent: ${sent.reason}${sent.error ? ` (${sent.error})` : ""}`,
          );
        }
      },
    },
    emailVerification: {
      ...authOptions.emailVerification,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail(env, "email-verification", user.email, url);
      },
    },
    ...(socialProviders ? { socialProviders } : {}),
  });
}

// The concrete Better Auth instance type, inferred from the factory so it
// carries our exact options (adapter, providers) rather than the widened default.
export type Auth = ReturnType<typeof buildAuth>;

// One instance per env object. Workers reuse the same `env` across a request, so
// this memoizes within an isolate without leaking between environments.
const cache = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  let auth = cache.get(env);
  if (!auth) {
    auth = buildAuth(env);
    cache.set(env, auth);
  }
  return auth;
}
