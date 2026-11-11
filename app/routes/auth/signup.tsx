import { readForm } from "@dustinedwards/site-runtime/body";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { CONFIRM_PATH, signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { SIGN_IN_INTENT, signInFormAction } from "@dustinedwards/site-runtime/sign-in-form";
import { SignIn } from "capsomer/react/sign-in";
import { data, Form, redirect, useNavigation } from "react-router";
import { Link } from "capsomer/react/link";

import { authClient } from "~/lib/auth/client";
import { getAuth } from "~/lib/auth";
import { nextPath, passkeyOfferURL, signedInLanding } from "~/lib/auth/landing.server";
import {
  checkAuthLimit,
  limitedData,
  SIGN_IN_LIMITED,
  SIGN_UP_LIMITED,
} from "~/lib/auth/rate-limit.server";
import { getSession } from "~/lib/auth/session";
import { DEFAULT_NEXT_PATH } from "~/lib/auth/sign-in-paths";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/signup";

// Row A3, /signup: Recova's app/(auth)/signup/page.tsx (blob 08400b4d), read
// whole, for the frame: one card, "Connect Stripe once", the fee line, the
// ways in, then "Already have an account? Sign in". The ways in are the
// family's one sign-in screen (Capsomer's SignIn on site-runtime's
// sign-in-form; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24),
// the same on every page a person signs in on, so the passkey button is here
// too (someone who already has one is signed in by it). The link signs in an
// existing merchant as well, so the page says the same either way.
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
  return [{ title: "Sign up - Foxhound" }, NOINDEX];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // A signed-in visitor never sees the page: Recova hides its "Already have
  // an account?" line from one.
  //
  // next= is where to land once signed up: the invite page sends a
  // signed-out "Accept invite" here with next=/invite/:token, as Recova's
  // sent it to /signup?invite=true, so the invite is accepted on the way back.
  const next = nextPath(new URL(request.url).searchParams.get("next"));
  const session = await getSession(env, request);
  if (session) throw redirect(await signedInLanding(env, session, next));
  return { next, methods: signInMethods(env, { social: true }) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // The form is read first (bounded, and nothing is sent yet) only to tell a
  // typed code from a link request: a code sends no mail and spends only the
  // shared auth bucket, as a sign-in does, while a link also spends ruling
  // 24's five signups an hour. Both before Better Auth is called.
  const form = await readForm(request, BODY_MAX_BYTES);
  const isCode = form.get(SIGN_IN_INTENT) === "code";
  const refusal = await checkAuthLimit(env, request, isCode ? "credential" : "signup");
  if (refusal) {
    return limitedData(
      { sent: null, error: isCode ? SIGN_IN_LIMITED : SIGN_UP_LIMITED, codeError: null },
      refusal,
    );
  }

  const result = await signInFormAction(await getAuth(env), request, form, {
    landing: (next) => passkeyOfferURL(env, next),
    // A spent or expired link comes back to its confirm page, which says which.
    errorLanding: new URL(CONFIRM_PATH, env.BETTER_AUTH_URL).toString(),
    next: { fallback: DEFAULT_NEXT_PATH },
  });
  if ("location" in result) throw redirect(result.location, { headers: result.headers });
  return data(result.state, { status: result.status });
}

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const { next } = loaderData;
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carried = next !== DEFAULT_NEXT_PATH ? next : undefined;

  return (
    <SignIn
      layout="screen"
      title="Connect Stripe once"
      lede={`You pay ${RECOVERY_FEE_PERCENT}% of what we recover. Nothing until then.`}
      client={authClient}
      methods={loaderData.methods}
      state={actionData ?? null}
      passkeyLanding={next}
      next={carried}
      pending={pending}
      Form={Form}
      footer={
        <p>
          Already have an account?{" "}
          <Link to={carried ? `/login?next=${encodeURIComponent(carried)}` : "/login"}>
            Sign in
          </Link>
        </p>
      }
    />
  );
}
