import { signInOptions } from "@dustinedwards/site-runtime/sign-in";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "~/db/client";
import * as authSchema from "~/db/auth-schema";

import { withSignIn } from "./options";
import { sendSignInLinkEmail } from "./send-auth-email";

// Runtime Better Auth factory, with the family's one sign-in (site-runtime
// ./sign-in): a passkey first, an emailed link and code before one exists (Turnstile on
// it once its keys are set), Google and Apple, no passwords. Accounts are joined
// only by a signed-in person. Built from the Cloudflare `env` so it binds the
// D1-backed Drizzle adapter (binding `DB`) and offers only the providers whose
// settings are present. The CLI schema generator uses a separate static instance
// (generate.config.ts); this file is the one application code imports.
//
// Env inputs (see env.d.ts / docs/auth/README.md):
//   BETTER_AUTH_SECRET   secret  - signing key (required in real environments)
//   BETTER_AUTH_URL      var     - canonical origin; its host is the passkey's
//   GOOGLE_CLIENT_ID     var     - Google sign-in, with GOOGLE_CLIENT_SECRET
//   APPLE_*              secrets - Apple sign-in (site-runtime ./apple-secret)
//   TURNSTILE_*          var/secret - the check on the email link

async function buildAuth(env: Env) {
  const db = getDb(env);
  const signIn = await signInOptions(env, {
    siteName: "Foxhound",
    social: true,
    sendMagicLink: async ({ email, url, token, code }) => {
      const sent = await sendSignInLinkEmail(env, { to: email, url, token, code });
      // A refused send is thrown by name so it is not silent. The message
      // carries the reason and the provider's words with the link cut out,
      // never the link. Better Auth answers the form the same way whether or
      // not an address exists.
      if (sent.status !== "sent") {
        throw new Error(`sign-in link email not sent: ${sent.reason}${sent.error ? ` (${sent.error})` : ""}`);
      }
    },
    // Five sign-in links an hour and ten typed codes a day per address.
    emailLimiter: env.AUTH_RATE_LIMITER,
  });

  const google = signIn.socialProviders.google;
  return betterAuth({
    ...withSignIn(signIn),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    socialProviders: {
      ...signIn.socialProviders,
      // Google returns to the canonical ROUTES.md path (/auth/google/callback)
      // instead of Better Auth's default /api/auth/callback/google. That route
      // forwards into the Better Auth handler, so the redirect_uri sent to
      // Google, the token exchange, and the CSRF state cookie validation all
      // agree. This is the URI registered on the Google OAuth client.
      ...(google ? { google: { ...google, redirectURI: `${env.BETTER_AUTH_URL}/auth/google/callback` } } : {}),
    },
  });
}

// The concrete Better Auth instance type, inferred from the factory so it
// carries our exact options (adapter, providers, plugins) rather than the
// widened default.
export type Auth = Awaited<ReturnType<typeof buildAuth>>;

// One instance per env object, the promise kept: Workers reuse the same `env`
// across a request, and Apple's client secret is signed with WebCrypto on each
// build. This memoizes within an isolate without leaking between environments.
const cache = new WeakMap<Env, Promise<Auth>>();

export function getAuth(env: Env): Promise<Auth> {
  let auth = cache.get(env);
  if (!auth) {
    auth = buildAuth(env);
    cache.set(env, auth);
  }
  return auth;
}
