import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthFootnote,
  AuthHeading,
  AuthLink,
  PasskeyContinue,
  SIGN_IN_CODE_QUERY,
  SignInLinkForm,
  SignInLinkSent,
  SocialContinue,
} from "~/components/auth-card";
import { checkAuthLimit, limitedData, SIGN_IN_LIMITED } from "~/lib/auth/rate-limit.server";
import { DEFAULT_NEXT_PATH, REAUTH_PARAM, safeNextPath } from "~/lib/auth/next-path";
import { signedInLanding } from "~/lib/auth/landing.server";
import { getSession } from "~/lib/auth/session";
import { answerSignInForm, signInErrorMessage } from "~/lib/auth/sign-in-link.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/login";
import { NOINDEX } from "~/lib/seo/meta";

// Row A2, /login: Recova's app/(auth)/login/page.tsx (blob ec09cd24),
// read whole, for the frame: one card, "Welcome back", the line under it, the
// providers, the "or" rule, Email, the error, then "Don't have an account?
// Connect Stripe". The ways in are the family's one sign-in (site-runtime
// ./sign-in; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): a
// passkey first, Google and Apple, and an emailed link in place of Recova's
// password. The mechanism is Foxhound's: Better Auth on D1, never Recova's
// Supabase client calls.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  // Where to land after signing in: Recova's login read next=
  // through validateRedirect, which /oauth/authorize relies on to bring a
  // signed-out merchant back to the consent page with every parameter. The
  // checks are anchored (app/lib/auth/next-path.ts); anything else lands on
  // /console, as before.
  const next = safeNextPath(params.get("next"));
  // Same session read appShellMiddleware uses (guards.ts): a signed-in
  // visitor hitting /login otherwise saw the sign-in form while the header
  // already showed them authenticated.
  // ?reauth (signInAgainIfStale) lets a signed-in person sign in again: adding
  // a passkey or unlinking needs a sign-in from the last 10 minutes.
  const reauth = params.has(REAUTH_PARAM);
  const session = await getSession(env, request);
  if (session && !reauth) throw redirect(await signedInLanding(env, session, next));
  const code = params.get("error");
  return {
    next,
    reauth,
    methods: signInMethods(env, { social: true }),
    error: signInErrorMessage(code),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read or mail is sent.
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ sent: null, error: SIGN_IN_LIMITED, codeError: null }, refusal);

  const isCode = new URL(request.url).searchParams.has(SIGN_IN_CODE_QUERY);
  return answerSignInForm(env, request, await request.formData(), { isCode, limited: SIGN_IN_LIMITED });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const error = actionData ? actionData.error : loaderData.error;
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carriedNext = loaderData.next !== DEFAULT_NEXT_PATH ? loaderData.next : undefined;

  return (
    <AuthCard>
      <AuthHeading
        title={loaderData.reauth ? "Sign in again" : "Welcome back"}
        subtitle={loaderData.reauth ? "To change how you sign in, sign in again." : "Sign in to your Foxhound account"}
      />

      {actionData?.sent ? (
        <SignInLinkSent
          idPrefix="login"
          email={actionData.sent}
          next={carriedNext}
          error={actionData.codeError}
          busy={busy}
        />
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
