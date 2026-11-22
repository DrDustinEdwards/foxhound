import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthFootnote,
  AuthHeading,
  SIGN_IN_CODE_QUERY,
  SignInLinkForm,
  SignInLinkSent,
  SocialContinue,
} from "~/components/auth-card";
import { AuthLink } from "~/components/auth-link";
import {
  checkAuthLimit,
  limitedData,
  SIGN_IN_LIMITED,
  SIGN_UP_LIMITED,
} from "~/lib/auth/rate-limit.server";
import { safeNextPath } from "@dustinedwards/site-runtime/sign-in-form";
import { DEFAULT_NEXT_PATH } from "~/lib/auth/next-path";
import { signedInLanding } from "~/lib/auth/landing.server";
import { getSession } from "~/lib/auth/session";
import { answerSignInForm } from "~/lib/auth/sign-in-link.server";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import type { Route } from "./+types/signup";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /signup: one card, "Connect Stripe once", the fee line, the providers, the "or" rule, Email, the error, then "Already have an account? Log in". The ways in are the family's one sign-in (site-runtime ./sign-in): Google, Apple, or an emailed link. The link signs in an existing merchant too, so the page says the same either way. No passkey button: a new merchant has none yet, and the link offers one. The fee is read from RECOVERY_FEE_BPS, never retyped. There is no "We start recovering immediately." clause: a soft failure waits for Stripe's own retries, while a hard decline, or any failure for a merchant with Smart Retries off, starts at once, so no single timing clause is true. No Name field.

export function meta() {
  return [{ title: "Sign up - Foxhound" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // Same session read appShellMiddleware uses (guards.ts): a signed-in visitor hitting /signup otherwise saw the create-account form. next= is where to land once signed up: the invite page sends a signed-out "Accept invite" here with next=/invite/:token, so the invite is accepted on the way back. Validated as /login validates it (app/lib/auth/next-path.ts).
  const next = safeNextPath(new URL(request.url).searchParams.get("next"), {
    fallback: DEFAULT_NEXT_PATH,
  });
  const session = await getSession(env, request);
  if (session) throw redirect(await signedInLanding(env, session, next));
  return { next, methods: signInMethods(env, { social: true }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read: the shared auth bucket, then five signups an hour. A typed code (the query says so) sends no mail and spends only the shared bucket, as a sign-in does.
  const isCode = new URL(request.url).searchParams.has(SIGN_IN_CODE_QUERY);
  const refusal = await checkAuthLimit(env, request, isCode ? "credential" : "signup");
  if (refusal) {
    return limitedData(
      { sent: null, error: isCode ? SIGN_IN_LIMITED : SIGN_UP_LIMITED, codeError: null },
      refusal,
    );
  }

  return answerSignInForm(env, request, await readForm(request, BODY_MAX_BYTES));
}

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carriedNext = loaderData.next !== DEFAULT_NEXT_PATH ? loaderData.next : undefined;

  return (
    <AuthCard>
      <AuthHeading
        title="Create your account"
        subtitle={`Next you connect Stripe. You pay ${RECOVERY_FEE_PERCENT}% of what we recover, nothing until then.`}
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
        <AuthLink to={carriedNext ? `/login?next=${encodeURIComponent(carriedNext)}` : "/login"}>
          Sign in
        </AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
