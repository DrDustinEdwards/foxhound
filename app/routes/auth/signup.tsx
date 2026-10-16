import { Alert, Banner } from "capsomer/react/banner";
import { data, Form, redirect, useNavigation } from "react-router";

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
import { authErrorMessage } from "~/lib/auth/http";
import { MIN_PASSWORD_LENGTH } from "~/lib/auth/password-policy";
import { checkAuthLimit, limitedData, SIGN_UP_LIMITED } from "~/lib/auth/rate-limit.server";
import { getSession } from "~/lib/auth/session";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/signup";

// Row A3, /signup (J52): Recova's app/(auth)/signup/page.tsx (blob 08400b4d),
// read whole. One card: "Connect Stripe once", the fee line, Continue with
// Google, the "or" rule, Email, Password "(min N characters)", the error,
// "Sign up", then "Already have an account? Log in".
//
// Three things are Foxhound's own and stay:
// - the fee is read from RECOVERY_FEE_BPS (RULES.md 2.1), never retyped;
// - the minimum length is Foxhound's MIN_PASSWORD_LENGTH (12), not Recova's 8,
//   because the label states the rule the engine enforces;
// - Better Auth requires a verified email before the first sign-in, so a
//   signup ends on a check-your-email state rather than Recova's jump to
//   /connect.
// Recova has no Name field, so Foxhound's is gone; Better Auth's name is sent
// empty, as Recova stored no name for an email signup.
// No Turnstile: Recova has none on signup, and none is recorded (ROWS-A A3).

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
  if (session) throw redirect("/console");
  return { googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First, before the form is read: the shared auth bucket, then ruling 24's
  // five signups an hour (J52).
  const refusal = await checkAuthLimit(env, request, "signup");
  if (refusal) return limitedData({ ok: false as const, email: null, error: SIGN_UP_LIMITED }, refusal);

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  // Verification is required and auto-sign-in is off, so a successful signup
  // creates the account and sends the verification email but does NOT
  // establish a session.
  const res = await getAuth(env).api.signUpEmail({
    body: { name: "", email, password, callbackURL: "/login?verified=1" },
    headers: request.headers,
    asResponse: true,
  });

  if (res.ok) {
    return data({ ok: true as const, email, error: null });
  }
  return data(
    {
      ok: false as const,
      email: null,
      error: await authErrorMessage(res, "Something went wrong"),
    },
    { status: 400 },
  );
}

export default function Signup({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  if (actionData?.ok) {
    return (
      <AuthCard>
        <AuthHeading title="Check your email" />
        <Banner tone="ok">
          Account created for {actionData.email}. We sent a verification link to finish setting up
          your account.
        </Banner>
        <AuthFootnote>
          Already verified? <AuthLink to="/login">Log in</AuthLink>
        </AuthFootnote>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading
        title="Connect Stripe once"
        subtitle={`We start recovering where Stripe's own retries stop. You pay ${RECOVERY_FEE_PERCENT}% of what we recover. Nothing until then.`}
      />

      {loaderData.googleEnabled ? <GoogleContinue /> : null}

      <Form method="post">
        <div className="mb-4">
          <AuthField
            id="signup-email"
            errorId={actionData?.error ? "signup-error" : undefined}
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
          />
        </div>
        <div className="mb-6">
          <AuthField
            id="signup-password"
            errorId={actionData?.error ? "signup-error" : undefined}
            label="Password"
            hint={`(min ${MIN_PASSWORD_LENGTH} characters)`}
            name="password"
            type="password"
            autoComplete="new-password"
          />
        </div>
        {actionData?.error ? (
          <div id="signup-error" className="mb-4">
            <Alert tone="crit">{actionData.error}</Alert>
          </div>
        ) : null}
        <AuthSubmit busy={busy} label="Sign up" busyLabel="Creating account..." />
      </Form>

      <AuthFootnote>
        Already have an account? <AuthLink to="/login">Log in</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
