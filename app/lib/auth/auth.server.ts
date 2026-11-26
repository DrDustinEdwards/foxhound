import { EMAIL_CONFIRM_PATH, signInOptions } from "@dustinedwards/site-runtime/sign-in";
import { accountOptions } from "@dustinedwards/site-runtime/sign-in-form";
// The minimal build: the database is the Drizzle adapter, so Kysely and the
// schema-migration code the full build bundles never run here (Better Auth:
// "For minimal mode (without Kysely), import from better-auth/minimal").
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "~/db/client";
import * as authSchema from "~/db/auth-schema";

import { accountDeletionHooks } from "./delete-account.server";
import { withSignIn } from "./options";
import { sendEmailChange, mailSecurityNotice, sendSignInLinkEmail } from "./send-auth-email";

// Runtime Better Auth factory, with the family's one sign-in (site-runtime
// ./sign-in): a passkey first, an emailed link and code before one exists
// (Turnstile on it), Google and Apple, no passwords. Accounts are joined only
// by a signed-in person.
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
        throw new Error(
          `sign-in link email not sent: ${sent.reason}${sent.error ? ` (${sent.error})` : ""}`,
        );
      }
    },
    // Five sign-in links an hour per address; wrong codes three an hour and ten
    // a day, counted across links.
    emailLimiter: env.AUTH_RATE_LIMITER,
    // Each auth event is also a row in auth_events (migration 0068): the
    // security history on /settings/account, /health's spike check and the
    // new-device and recovery notices read it.
    eventsDb: env.DB,
    // Each session keeps its rough place and a device id (site-runtime's device
    // cookie; migrations 0069 and 0070), and a read moves its updatedAt, so the
    // signed-in devices list shows where and when each was last used, and the
    // new-device notice tells two browsers of one make apart.
    sessionDetails: true,
    // A passkey added or removed, Google or Apple joined or left, sessions
    // ended, the account deleted, a new device, a recovery: mailed to the
    // account's address.
    sendSecurityNotice: (_kind, { user, detail }) => mailSecurityNotice(env, user.email, detail),
  });

  const google = signIn.socialProviders.google;
  const options = withSignIn(signIn);
  const account = accountOptions({
    confirmPath: EMAIL_CONFIRM_PATH,
    sendEmailChange: (mail) => sendEmailChange(env, mail),
    ...accountDeletionHooks(env),
  });
  return betterAuth({
    ...options,
    // Changing the address (two links: the current address approves, then the new one confirms, each through
    // /email/confirm) and deleting the account (only from /settings/account's action, with Foxhound's deletion in its
    // hooks: the fee evidence kept, the rest scrubbed, then the Stripe grants revoked): site-runtime's accountOptions,
    // the same on every site. Its disabledPaths add /send-verification-email and /delete-user to the sign-in's own.
    ...account,
    disabledPaths: [...options.disabledPaths, ...account.disabledPaths],
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    socialProviders: {
      ...signIn.socialProviders,
      // Google returns to the canonical ROUTES.md path (/auth/google/callback)
      // instead of Better Auth's default /api/auth/callback/google. That route
      // forwards into the Better Auth handler, so the redirect_uri sent to
      // Google, the token exchange, and the CSRF state cookie validation all
      // agree.
      ...(google
        ? { google: { ...google, redirectURI: `${env.BETTER_AUTH_URL}/auth/google/callback` } }
        : {}),
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

export function getBetterAuth(env: Env): Promise<Auth> {
  let auth = cache.get(env);
  if (!auth) {
    auth = buildAuth(env);
    cache.set(env, auth);
  }
  return auth;
}
