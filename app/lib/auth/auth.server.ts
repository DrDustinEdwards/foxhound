import { EMAIL_CONFIRM_PATH, signInOptions } from "@dustinedwards/site-runtime/sign-in";
import {
  accountOptions,
  DISPOSABLE_EMAIL,
  isDisposableEmail,
} from "@dustinedwards/site-runtime/sign-in-form";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "~/db/client";
import * as authSchema from "~/db/auth-schema";

import { accountDeletionHooks } from "./delete-account.server";
import { withSignIn } from "./options";
import {
  sendEmailChangeEmail,
  sendSecurityNoticeEmail,
  sendSignInLinkEmail,
} from "./send-auth-email";

// Runtime Better Auth factory, with the family's one sign-in (site-runtime
// ./sign-in): a passkey first, an emailed link and code before one exists (Turnstile on
// it), Google and Apple, no passwords. Accounts are joined
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
    // Each session keeps its rough place and a device id (site-runtime's
    // device cookie; migrations 0069 and 0070), and a read moves its
    // updatedAt, so the signed-in devices list shows where and when each was
    // last used, and the new-device notice tells two browsers of one make apart.
    sessionDetails: true,
    // A passkey added or removed, Google or Apple joined or left, sessions
    // ended, the account deleted, a new device, a recovery: mailed to the
    // account's address.
    sendSecurityNotice: (_kind, { user, detail }) =>
      sendSecurityNoticeEmail(env, user.email, detail),
  });

  // The email change and deletion, the same on every site (site-runtime's
  // accountOptions): two links for a change of address, the CURRENT address
  // first, each opening /email/confirm, and deletion only from the
  // /settings/account action (accountFormAction, after its fresh sign-in
  // check), never Better Auth's /delete-user over HTTP.
  const deletion = accountDeletionHooks(env);
  const account = accountOptions({
    confirmPath: EMAIL_CONFIRM_PATH,
    sendEmailChange: async (mail) => {
      // The disposable check accountFormAction makes, held here too for a
      // change asked for straight at /api/auth/change-email.
      if (mail.newEmail && isDisposableEmail(mail.newEmail)) {
        throw new APIError("BAD_REQUEST", {
          code: DISPOSABLE_EMAIL,
          message: "Disposable email addresses are not allowed.",
        });
      }
      await sendEmailChangeEmail(env, mail);
    },
    // Foxhound's deletion (delete-account.server.ts): the fee evidence kept,
    // the rest scrubbed; then, after Better Auth deletes the person, the
    // Stripe grants revoked.
    beforeDelete: deletion.beforeDelete,
  });

  const google = signIn.socialProviders.google;
  const options = withSignIn(signIn);
  return betterAuth({
    ...options,
    disabledPaths: [...options.disabledPaths, ...account.disabledPaths],
    emailVerification: account.emailVerification,
    user: {
      ...account.user,
      deleteUser: { ...account.user.deleteUser, afterDelete: deletion.afterDelete },
    },
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

export function getAuth(env: Env): Promise<Auth> {
  let auth = cache.get(env);
  if (!auth) {
    auth = buildAuth(env);
    cache.set(env, auth);
  }
  return auth;
}
