import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { data, redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthFootnote,
  AuthHeading,
  AuthLink,
  PasskeyContinue,
  SignInLinkForm,
  SignInLinkSent,
  SocialContinue,
} from "~/components/auth-card";
import {
  checkAuthLimit,
  limitedData,
  RATE_LIMITED_ERROR,
  SIGN_IN_LIMITED,
} from "~/lib/auth/rate-limit.server";
import { DEFAULT_NEXT_PATH, safeNextPath } from "~/lib/auth/next-path";
import { getSession } from "~/lib/auth/session";
import { requestSignInLink, signInLinkAnswer } from "~/lib/auth/sign-in-link.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/login";

// Row A2, /login (J52): Recova's app/(auth)/login/page.tsx (blob ec09cd24),
// read whole, for the frame: one card, "Welcome back", the line under it, the
// providers, the "or" rule, Email, the error, then "Don't have an account?
// Connect Stripe". The ways in are the family's one sign-in (site-runtime
// ./sign-in; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): a
// passkey first, Google and Apple, and an emailed link in place of Recova's
// password. The mechanism is Foxhound's: Better Auth on D1, never Recova's
// Supabase client calls.

export function meta() {
  return [{ title: "Log in - Foxhound" }];
}

/** The ?error= codes something sends here: the limiter's, and Better Auth's
 *  from a spent link or a refused Google or Apple sign-in. */
const LINK_SPENT = "That sign-in link has expired or was already used. Send yourself a new one.";
const ERROR_MESSAGES: Record<string, string> = {
  [RATE_LIMITED_ERROR]: SIGN_IN_LIMITED,
  EXPIRED_TOKEN: LINK_SPENT,
  INVALID_TOKEN: LINK_SPENT,
  ATTEMPTS_EXCEEDED: LINK_SPENT,
  // Accounts are joined only by a signed-in person (site-runtime ./sign-in),
  // never by a matching email at sign-in, so this one has a way forward.
  account_not_linked:
    "That email already has a Foxhound account. Sign in with an email link, then connect Google or Apple in My account.",
};
const SIGN_IN_FAILED = "That sign-in did not complete. Try again or use another way.";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  // Where to land after signing in (J79; ruling 8): Recova's login read next=
  // through validateRedirect, which /oauth/authorize relies on to bring a
  // signed-out merchant back to the consent page with every parameter. The
  // checks are anchored (app/lib/auth/next-path.ts); anything else lands on
  // /console, as before.
  const next = safeNextPath(params.get("next"));
  // Same session read appShellMiddleware uses (guards.ts): a signed-in
  // visitor hitting /login otherwise saw the sign-in form while the header
  // already showed them authenticated.
  const session = await getSession(env, request);
  if (session) throw redirect(next);
  const code = params.get("error");
  return {
    next,
    methods: signInMethods(env, { social: true }),
    error: code ? (ERROR_MESSAGES[code] ?? SIGN_IN_FAILED) : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read or mail is sent (J52).
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ sent: null, error: SIGN_IN_LIMITED }, refusal);

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!email) return data({ sent: null, error: "Enter your email address." }, { status: 400 });
  const next = safeNextPath(String(form.get("next") ?? ""));

  const result = await requestSignInLink(env, request, {
    email,
    captchaToken: String(form.get("cf-turnstile-response") ?? ""),
    next,
    // Someone new through /login lands where a Google signup does.
    newUserNext: next,
  });
  return signInLinkAnswer(result, email, SIGN_IN_LIMITED);
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const error = actionData ? actionData.error : loaderData.error;
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carriedNext = loaderData.next !== DEFAULT_NEXT_PATH ? loaderData.next : undefined;

  return (
    <AuthCard>
      <AuthHeading title="Welcome back" subtitle="Log in to your Foxhound account" />

      {actionData?.sent ? (
        <SignInLinkSent email={actionData.sent} />
      ) : (
        <>
          <PasskeyContinue next={loaderData.next} />
          <SocialContinue methods={loaderData.methods} next={carriedNext} afterPasskey />
          <SignInLinkForm
            idPrefix="login"
            turnstileSiteKey={loaderData.methods.turnstileSiteKey}
            next={carriedNext}
            error={error}
            busy={busy}
            attempt={actionData}
          />
        </>
      )}

      <AuthFootnote>
        Don&apos;t have an account? <AuthLink to="/signup">Connect Stripe</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
