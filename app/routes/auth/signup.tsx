import { data, Form, useActionData, useNavigation } from "react-router";

import {
  AuthShell,
  Field,
  Submit,
  Alert,
  AuthLink,
  GoogleButton,
} from "~/components/auth-ui";
import { getAuth } from "~/lib/auth";
import { authErrorMessage } from "~/lib/auth/http";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/signup";

export function meta() {
  return [{ title: "Create account - Foxhound" }];
}

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return { googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  // Verification is required and auto-sign-in is off, so a successful signup
  // creates the account and dispatches the verification email (logged in Phase
  // 3) but does NOT establish a session. We show a check-your-email state rather
  // than redirecting into the app.
  const res = await getAuth(env).api.signUpEmail({
    body: { name, email, password },
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
      error: await authErrorMessage(res, "Could not create account."),
    },
    { status: 400 },
  );
}

export default function Signup({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (actionData?.ok) {
    return (
      <AuthShell
        title="Check your email"
        footer={<>Already verified? <AuthLink to="/login">Sign in</AuthLink></>}
      >
        <Alert tone="success">
          Account created for {actionData.email}. We sent a verification link to
          finish setting up your account.
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start recovering revenue with Foxhound."
      footer={<>Have an account? <AuthLink to="/login">Sign in</AuthLink></>}
    >
      <Form method="post" className="flex flex-col gap-4">
        {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
        <Field label="Name" name="name" autoComplete="name" />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
        />
        <Submit disabled={busy}>{busy ? "Creating..." : "Create account"}</Submit>
      </Form>
      {loaderData.googleEnabled ? <GoogleButton label="Sign up with Google" /> : null}
    </AuthShell>
  );
}
