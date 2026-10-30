import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthFootnote,
  AuthHeading,
  AuthLink,
  SIGN_IN_CODE_QUERY,
  SignInLinkForm,
  SignInLinkSent,
  SocialContinue,
} from "~/components/auth-card";
import { checkAuthLimit, limitedData, SIGN_IN_LIMITED, SIGN_UP_LIMITED } from "~/lib/auth/rate-limit.server";
import { DEFAULT_NEXT_PATH, safeNextPath } from "~/lib/auth/next-path";
import { signedInLanding } from "~/lib/auth/landing.server";
import { getSession } from "~/lib/auth/session";
import { answerSignInForm } from "~/lib/auth/sign-in-link.server";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/signup";

// Row A3, /signup: Recova's app/(auth)/signup/page.tsx (blob 08400b4d),
// read whole, for the frame: one card, "Connect Stripe once", the fee line,
// the providers, the "or" rule, Email, the error, then "Already have an
// account? Log in". The ways in are the family's one sign-in (site-runtime
// ./sign-in; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): Google,
// Apple, or an emailed link in place of Recova's password. The link signs in
// an existing merchant too, so the page says the same either way. No passkey
// button: a new merchant has none yet, and the link offers one.
//
// Two things are Foxhound's own and stay:
// - the fee is read from RECOVERY_FEE_BPS, never retyped;
// - Recova's line opened with "We start recovering immediately.", which is
//   untrue here: a soft failure waits for Stripe's own retries,
//   while a hard decline, or any failure for a merchant with Smart Retries
//   off, starts at once. No single timing clause is true, so it is dropped.
// Recova has no Name field, so there is none; Better Auth's name is empty, as
// Recova stored no name for an email signup.

export function meta() {
  return [{ title: "Sign up - Foxhound" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // Same session read appShellMiddleware uses (guards.ts): a signed-in
  // visitor hitting /signup otherwise saw the create-account form. Recova
  // hides its "Already have an account?" line from a signed-in visitor; here
  // that visitor never sees the page.
  //
  // next= is where to land once signed up: the invite page sends
  // a signed-out "Accept invite" here with next=/invite/:token, as Recova's
  // sent it to /signup?invite=true, so the invite is accepted on the way back.
  // Validated the way /login validates it (app/lib/auth/next-path.ts).
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  const session = await getSession(env, request);
  if (session) throw redirect(await signedInLanding(env, session, next));
  return { next, methods: signInMethods(env, { social: true }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read: the shared auth bucket, then ruling 24's
  // five signups an hour. A typed code (the query says so) sends no mail
  // and spends only the shared bucket, as a sign-in does.
  const isCode = new URL(request.url).searchParams.has(SIGN_IN_CODE_QUERY);
  const refusal = await checkAuthLimit(env, request, isCode ? "credential" : "signup");
  if (refusal) {
    return limitedData({ sent: null, error: isCode ? SIGN_IN_LIMITED : SIGN_UP_LIMITED, codeError: null }, refusal);
  }

  return answerSignInForm(env, request, await request.formData(), { isCode, limited: SIGN_UP_LIMITED });
}

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carriedNext = loaderData.next !== DEFAULT_NEXT_PATH ? loaderData.next : undefined;

  return (
    <AuthCard>
      <AuthHeading
        title="Connect Stripe once"
        subtitle={`You pay ${RECOVERY_FEE_PERCENT}% of what we recover. Nothing until then.`}
      />

      {actionData?.sent ? (
        <SignInLinkSent
          idPrefix="signup"
          email={actionData.sent}
          next={carriedNext}
          error={actionData.codeError}
          busy={busy}
        />
      ) : (
        <>
          <SocialContinue methods={loaderData.methods} next={carriedNext} />
          <SignInLinkForm
            primary
            idPrefix="signup"
            next={carriedNext}
            turnstileSiteKey={loaderData.methods.turnstileSiteKey}
            error={actionData?.error ?? null}
            busy={busy}
            attempt={actionData}
          />
        </>
      )}

      <AuthFootnote>
        Already have an account?{" "}
        <AuthLink to={carriedNext ? `/login?next=${encodeURIComponent(carriedNext)}` : "/login"}>Log in</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
