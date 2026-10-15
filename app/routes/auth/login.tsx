import { data, Form, redirect, useActionData, useNavigation } from "react-router";

import {
  AuthShell,
  Field,
  Submit,
  Alert,
  AuthLink,
  GoogleButton,
} from "~/components/auth-ui";
import { getAuth } from "~/lib/auth";
import { authErrorMessage, forwardSetCookie } from "~/lib/auth/http";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/login";

export function meta() {
  return [{ title: "Sign in - Foxhound" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // Same session read appShellMiddleware uses (guards.ts): a signed-in
  // visitor hitting /login otherwise saw the sign-in form while the header
  // already showed them authenticated.
  const session = await getSession(env, request);
  if (session) throw redirect("/console");
  const verified = new URL(request.url).searchParams.get("verified") === "1";
  return { googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), verified };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const res = await getAuth(env).api.signInEmail({
    body: { email, password },
    headers: request.headers,
    asResponse: true,
  });

  if (res.ok) {
    return redirect("/console", { headers: forwardSetCookie(res) });
  }
  return data(
    { error: await authErrorMessage(res, "Invalid email or password.") },
    { status: 400 },
  );
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to Foxhound."
      footer={<>No account? <AuthLink to="/signup">Create one</AuthLink></>}
    >
      <Form method="post" className="flex flex-col gap-4">
        {loaderData.verified && !actionData?.error ? (
          <Alert tone="success">Your email is verified. You can sign in now.</Alert>
        ) : null}
        {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <div className="flex items-center justify-between">
          <AuthLink to="/forgot-password">Forgot password?</AuthLink>
          <Submit disabled={busy}>{busy ? "Signing in..." : "Sign in"}</Submit>
        </div>
      </Form>
      {loaderData.googleEnabled ? <GoogleButton label="Continue with Google" /> : null}
    </AuthShell>
  );
}
