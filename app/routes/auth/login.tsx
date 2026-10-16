import { Alert, Banner } from "capsomer/react/banner";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import {
  AuthCard,
  AuthField,
  AuthFootnote,
  AuthHeading,
  AuthLink,
  AuthSubmit,
  GoogleContinue,
} from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { authErrorMessage, forwardSetCookie } from "~/lib/auth/http";
import {
  checkAuthLimit,
  limitedData,
  RATE_LIMITED_ERROR,
  SIGN_IN_LIMITED,
} from "~/lib/auth/rate-limit.server";
import { DEFAULT_NEXT_PATH, safeNextPath } from "~/lib/auth/next-path";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/login";

// Row A2, /login (J52): Recova's app/(auth)/login/page.tsx (blob ec09cd24),
// read whole. One card: "Welcome back", the line under it, Continue with
// Google, the "or" rule, Email, Password with "Forgot password?" on its label
// row, the error, "Log in", then "Don't have an account? Connect Stripe".
// The mechanism is Foxhound's: Better Auth on D1 through this action, never
// Recova's Supabase client calls.

export function meta() {
  return [{ title: "Log in - Foxhound" }];
}

/** Recova's ?error= messages (login/page.tsx ERROR_MESSAGES), for the codes
 *  something in Foxhound sends here. Recova's disposable_email has no sender
 *  in Foxhound (the disposable check refuses inside Better Auth), so it is not
 *  carried. */
const ERROR_MESSAGES: Record<string, string> = {
  [RATE_LIMITED_ERROR]: SIGN_IN_LIMITED,
};

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
  return {
    next,
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    verified: params.get("verified") === "1",
    error: ERROR_MESSAGES[params.get("error") ?? ""] ?? null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read or a password is checked (J52).
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ error: SIGN_IN_LIMITED }, refusal);

  const form = await request.formData();
  const next = safeNextPath(String(form.get("next") ?? ""));
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const res = await getAuth(env).api.signInEmail({
    body: { email, password },
    headers: request.headers,
    asResponse: true,
  });

  if (res.ok) {
    return redirect(next, { headers: forwardSetCookie(res) });
  }
  return data(
    { error: await authErrorMessage(res, "Invalid email or password") },
    { status: 400 },
  );
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const error = actionData?.error ?? loaderData.error;
  // Carried only when it says somewhere other than the default, so the plain
  // page is unchanged.
  const carriedNext = loaderData.next !== DEFAULT_NEXT_PATH ? loaderData.next : undefined;

  return (
    <AuthCard>
      <AuthHeading title="Welcome back" subtitle="Log in to your Foxhound account" />

      {loaderData.googleEnabled ? <GoogleContinue next={carriedNext} /> : null}

      <Form method="post">
        {carriedNext ? <input type="hidden" name="next" value={carriedNext} /> : null}
        {/* Foxhound's own notice: its engine verifies an email before the
            first sign-in, and the verification link lands here. */}
        {loaderData.verified && !error ? (
          <div className="mb-4">
            <Banner tone="ok">Your email is verified. You can sign in now.</Banner>
          </div>
        ) : null}
        <div className="mb-4">
          <AuthField
            id="login-email"
            errorId={error ? "login-error" : undefined}
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
          />
        </div>
        <div className="mb-6">
          <AuthField
            id="login-password"
            errorId={error ? "login-error" : undefined}
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            aside={
              <Link
                to="/forgot-password"
                className="inline-flex min-h-6 items-center text-micro text-text-subtle underline underline-offset-2 hover:opacity-80"
              >
                Forgot password?
              </Link>
            }
          />
        </div>
        {error ? (
          <div id="login-error" className="mb-4">
            <Alert tone="crit">{error}</Alert>
          </div>
        ) : null}
        <AuthSubmit busy={busy} label="Log in" busyLabel="Logging in..." />
      </Form>

      <AuthFootnote>
        Don&apos;t have an account? <AuthLink to="/signup">Connect Stripe</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
