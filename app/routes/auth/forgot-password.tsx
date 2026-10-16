import { Alert } from "capsomer/react/banner";
import { data, Form, useNavigation } from "react-router";

import { AuthCard, AuthField, AuthFootnote, AuthHeading, AuthLink, AuthSubmit } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { checkAuthLimit, limitedData, SIGN_IN_LIMITED } from "~/lib/auth/rate-limit.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/forgot-password";

// Row A4, /forgot-password (J52): Recova's app/(auth)/forgot-password/page.tsx
// (blob 56e454f3), read whole. One card: "Reset your password", the line under
// it, Email with Recova's placeholder, "Send reset link", "← Back to login";
// once sent, Recova's envelope, "Check your email", the address in bold, and
// the way back. The send is Better Auth's requestPasswordReset, from the
// sign-in mail subdomain (RULES.md 4.13), never Recova's Supabase call.
//
// One sentence is corrected: Recova said "We sent a password reset link to"
// every address it was given. Foxhound never says whether an account exists
// (the answer is the same either way), so the sentence says "if an account
// exists", which is true for every address.

export function meta() {
  return [{ title: "Reset password - Foxhound" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First: a signed-out caller can make this send mail (J52).
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ ok: false as const, email: null, error: SIGN_IN_LIMITED }, refusal);

  const form = await request.formData();
  const email = String(form.get("email") ?? "");

  // Fire the reset request but always report the same result: never disclose
  // whether an account exists for the address (enumeration hardening).
  try {
    await getAuth(env).api.requestPasswordReset({
      body: { email, redirectTo: "/reset-password" },
      headers: request.headers,
    });
  } catch {
    // Swallow: the response is identical whether or not the email is known.
  }
  return data({ ok: true as const, email, error: null });
}

export default function ForgotPassword({ actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  if (actionData?.ok) {
    return (
      <AuthCard>
        <div className="mb-6 text-center">
          <div className="mb-4 text-display" aria-hidden="true">
            ✉️
          </div>
          <h1 className="mb-2 text-title font-semibold text-text">Check your email</h1>
          <p className="text-label leading-relaxed text-text-subtle">
            If an account exists for <strong className="text-text">{actionData.email}</strong>, we sent it a
            password reset link. Check your inbox and click the link to reset your password.
          </p>
        </div>
        <AuthFootnote>
          <AuthLink to="/login">← Back to login</AuthLink>
        </AuthFootnote>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading title="Reset your password" subtitle="Enter your email and we'll send you a reset link" />

      <Form method="post">
        <div className="mb-6">
          <AuthField
            id="forgot-email"
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@yourapp.com"
          />
        </div>
        {actionData?.error ? (
          <div className="mb-4">
            <Alert tone="crit">{actionData.error}</Alert>
          </div>
        ) : null}
        <AuthSubmit busy={busy} label="Send reset link" busyLabel="Sending..." />
      </Form>

      <AuthFootnote>
        <AuthLink to="/login">← Back to login</AuthLink>
      </AuthFootnote>
    </AuthCard>
  );
}
