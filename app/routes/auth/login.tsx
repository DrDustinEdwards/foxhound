import { readForm } from "@dustinedwards/site-runtime/body";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { CONFIRM_PATH, signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { signInErrorWords, signInFormAction } from "@dustinedwards/site-runtime/sign-in-form";
import { SignIn } from "capsomer/react/sign-in";
import { data, Form, redirect, useNavigation } from "react-router";
import { Link } from "capsomer/react/link";

import { authClient } from "~/lib/auth/client";
import { getAuth } from "~/lib/auth";
import { nextPath, passkeyOfferURL, signedInLanding } from "~/lib/auth/landing.server";
import { checkAuthLimit, limitedData, SIGN_IN_LIMITED } from "~/lib/auth/rate-limit.server";
import { getSession } from "~/lib/auth/session";
import { DEFAULT_NEXT_PATH, REAUTH_PARAM } from "~/lib/auth/sign-in-paths";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import { NOINDEX } from "~/lib/seo/meta";

import type { Route } from "./+types/login";

// Row A2, /login: Recova's app/(auth)/login/page.tsx (blob ec09cd24), read
// whole, for the frame: one card, "Welcome back", the line under it, the ways
// in, then "Don't have an account? Connect Stripe". The ways in are the
// family's one sign-in screen (Capsomer's SignIn on site-runtime's
// sign-in-form; APPROVED-DIFFERENCES, "Sign-in and invites", 2026-10-24): a
// passkey first, Google and Apple where their keys are set, and an emailed
// link and code in place of Recova's password.

export function meta() {
  return [{ title: "Sign in - Foxhound" }, NOINDEX];
}

/** The page's own words for an error it is opened with (?error=). */
const SITE_WORDS = { siteName: "Foxhound", settings: "My account" };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const params = new URL(request.url).searchParams;
  // Where to land after signing in: /oauth/authorize sends a signed-out
  // merchant here with its whole query in next=, and site-runtime's
  // safeNextPath keeps it; anything refused lands on /console.
  const next = nextPath(params.get("next"));
  // ?reauth lets a signed-in person sign in again: the email change, the
  // device list, deletion, adding a passkey and unlinking need a sign-in from
  // the last 10 minutes. Otherwise a signed-in visitor goes on.
  const reauth = params.has(REAUTH_PARAM);
  const session = await getSession(env, request);
  if (session && !reauth) throw redirect(await signedInLanding(env, session, next));
  return {
    next,
    reauth,
    methods: signInMethods(env, { social: true }),
    error: signInErrorWords(params.get("error"), SITE_WORDS),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read or mail is sent.
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ sent: null, error: SIGN_IN_LIMITED, codeError: null }, refusal);

  const result = await signInFormAction(
    await getAuth(env),
    request,
    await readForm(request, BODY_MAX_BYTES),
    {
      // By way of the passkey offer, which goes on to `next`.
      landing: (next) => passkeyOfferURL(env, next),
      // A spent or expired link comes back to its confirm page, which says which.
      errorLanding: new URL(CONFIRM_PATH, env.BETTER_AUTH_URL).toString(),
      next: { fallback: DEFAULT_NEXT_PATH },
    },
  );
  if ("location" in result) throw redirect(result.location, { headers: result.headers });
  return data(result.state, { status: result.status });
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const { next, reauth } = loaderData;
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carried = next !== DEFAULT_NEXT_PATH ? next : undefined;

  return (
    <SignIn
      layout="screen"
      title={reauth ? "Sign in again" : "Welcome back"}
      lede={
        reauth ? "To change how you sign in, sign in again." : "Sign in to your Foxhound account"
      }
      client={authClient}
      methods={loaderData.methods}
      state={actionData ?? null}
      error={loaderData.error}
      passkeyLanding={next}
      next={carried}
      pending={pending}
      Form={Form}
      footer={
        <p>
          Don&apos;t have an account? <Link to="/signup">Connect Stripe</Link>
        </p>
      }
    />
  );
}
