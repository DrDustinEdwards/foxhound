import { Form, useActionData, useNavigation } from "react-router";

import { AuthShell, Field, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/forgot-password";

export function meta() {
  return [{ title: "Reset password - Foxhound" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
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
  return { ok: true as const };
}

export default function ForgotPassword() {
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email you a link to set a new password."
      footer={<>Remembered it? <AuthLink to="/login">Sign in</AuthLink></>}
    >
      {actionData?.ok ? (
        <Alert tone="success">
          If an account exists for that email, a reset link is on its way.
        </Alert>
      ) : (
        <Form method="post" className="flex flex-col gap-4">
          <Field label="Email" name="email" type="email" autoComplete="email" />
          <Submit disabled={busy}>{busy ? "Sending..." : "Send reset link"}</Submit>
        </Form>
      )}
    </AuthShell>
  );
}
