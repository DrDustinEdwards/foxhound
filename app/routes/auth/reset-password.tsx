import { Alert, Banner } from "capsomer/react/banner";
import { data, Form, useNavigation } from "react-router";

import { AuthCard, AuthField, AuthFootnote, AuthHeading, AuthLink, AuthSubmit } from "~/components/auth-card";
import { getAuth } from "~/lib/auth";
import { authErrorMessage } from "~/lib/auth/http";
import { MIN_PASSWORD_LENGTH } from "~/lib/auth/password-policy";
import { checkAuthLimit, limitedData, SIGN_IN_LIMITED } from "~/lib/auth/rate-limit.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/reset-password";

// Row A5, /reset-password (J52): Recova's app/(auth)/reset-password/page.tsx
// (blob f371f0bb), read whole. One card: "Set new password", the line under
// it, New password, Confirm password, the error, "Update password". Recova
// checks the two match, then the length, before it calls anything; here the
// action does, so the check holds without script. The length is Foxhound's
// MIN_PASSWORD_LENGTH (12), the rule Better Auth enforces, not Recova's 8.
//
// The reset itself is Better Auth's, with the emailed token. Recova's reset
// left the visitor signed in and sent them home; an emailed link never signs
// anyone in here (RULES.md 4.13), so the page ends on "Password updated" with
// the way to log in.

export function meta() {
  return [{ title: "Set new password - Foxhound" }];
}

// The reset link points here with ?token=...; surface it to the action.
export function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token };
}

function refuse(error: string) {
  return data({ ok: false as const, error }, { status: 400 });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // First: a signed-out caller can make this test a token (J52).
  const refusal = await checkAuthLimit(env, request, "credential");
  if (refusal) return limitedData({ ok: false as const, error: SIGN_IN_LIMITED }, refusal);

  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  // Recova's two checks, in Recova's order and words.
  if (password !== confirm) return refuse("Passwords do not match");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return refuse(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!token) return refuse("This reset link is invalid or expired.");

  const res = await getAuth(env).api.resetPassword({
    body: { newPassword: password, token },
    headers: request.headers,
    asResponse: true,
  });

  if (res.ok) {
    return data({ ok: true as const, error: null });
  }
  return refuse(await authErrorMessage(res, "Could not reset password."));
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  if (actionData?.ok) {
    return (
      <AuthCard>
        <AuthHeading title="Password updated" />
        <Banner tone="ok">Your password has been reset.</Banner>
        <AuthFootnote>
          You can now <AuthLink to="/login">log in</AuthLink> with your new password.
        </AuthFootnote>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeading title="Set new password" subtitle="Choose a strong password for your account" />

      <Form method="post">
        <input type="hidden" name="token" value={loaderData.token} />
        <div className="mb-4">
          <AuthField
            id="reset-password"
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />
        </div>
        <div className="mb-6">
          <AuthField
            id="reset-confirm"
            label="Confirm password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            placeholder="Repeat your password"
          />
        </div>
        {actionData?.error ? (
          <div className="mb-4">
            <Alert tone="crit">{actionData.error}</Alert>
          </div>
        ) : null}
        <AuthSubmit busy={busy} label="Update password" busyLabel="Updating..." />
      </Form>
    </AuthCard>
  );
}
