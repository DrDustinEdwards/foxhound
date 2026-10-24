import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { data, redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthFootnote,
  AuthHeading,
  AuthLink,
  SignInLinkForm,
  SignInLinkSent,
  SocialContinue,
} from "~/components/auth-card";
import { checkAuthLimit, limitedData, SIGN_UP_LIMITED } from "~/lib/auth/rate-limit.server";
import { DEFAULT_NEXT_PATH } from "~/lib/auth/next-path";
import { getSession } from "~/lib/auth/session";
import { requestSignInLink, signInLinkAnswer } from "~/lib/auth/sign-in-link.server";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/signup";

// Row A3, /signup (J52): Recova's app/(auth)/signup/page.tsx (blob 08400b4d),
// read whole, for the frame: one card, "Connect Stripe once", the fee line,
// the providers, the "or" rule, Email, the error, then "Already have an
// account? Log in". The ways in are the family's one sign-in (site-runtime
// ./sign-in; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): Google,
// Apple, or an emailed link in place of Recova's password. The link signs in
// an existing merchant too, so the page says the same either way. No passkey
// button: a new merchant has none yet, and the link offers one.
//
// Two things are Foxhound's own and stay:
// - the fee is read from RECOVERY_FEE_BPS (RULES.md 2.1), never retyped;
// - Recova's line opened with "We start recovering immediately.", which is
//   untrue here: a soft failure waits for Stripe's own retries (RULES.md 3.3),
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
  const session = await getSession(env, request);
  if (session) throw redirect(DEFAULT_NEXT_PATH);
  return { methods: signInMethods(env, { social: true }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read: the shared auth bucket, then ruling 24's
  // five signups an hour (J52).
  const refusal = await checkAuthLimit(env, request, "signup");
  if (refusal) return limitedData({ sent: null, error: SIGN_UP_LIMITED }, refusal);

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (!email) return data({ sent: null, error: "Enter your email address." }, { status: 400 });

  const result = await requestSignInLink(env, request, {
    email,
    captchaToken: String(form.get("cf-turnstile-response") ?? ""),
    next: DEFAULT_NEXT_PATH,
    newUserNext: DEFAULT_NEXT_PATH,
  });
  return signInLinkAnswer(result, email, SIGN_UP_LIMITED);
}

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  return (
    <AuthCard>
      <AuthHeading
        title="Connect Stripe once"
        subtitle={`You pay ${RECOVERY_FEE_PERCENT}% of what we recover. Nothing until then.`}
      />

      {actionData?.sent ? (
        <SignInLinkSent email={actionData.sent} />
      ) : (
        <>
          <SocialContinue methods={loaderData.methods} />
          <SignInLinkForm
            idPrefix="signup"
            turnstileSiteKey={loaderData.methods.turnstileSiteKey}
            error={actionData?.error ?? null}
            busy={busy}
            attempt={actionData}
          />
        </>
      )}

      <AuthFootnote>
        Already have an account? <AuthLink to="/login">Log in</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
