import { data, Form, useActionData, useNavigation } from "react-router";

import { AuthShell, Field, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getAuth } from "~/lib/auth";
import { authErrorMessage } from "~/lib/auth/http";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/reset-password";

export function meta() {
  return [{ title: "Set new password - Foxhound" }];
}

// The reset link points here with ?token=...; surface it to the action.
export function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");

  if (!token) {
    return data({ ok: false as const, error: "This reset link is invalid or expired." }, { status: 400 });
  }

  const res = await getAuth(env).api.resetPassword({
    body: { newPassword: password, token },
    headers: request.headers,
    asResponse: true,
  });

  if (res.ok) {
    return data({ ok: true as const, error: null });
  }
  return data(
    { ok: false as const, error: await authErrorMessage(res, "Could not reset password.") },
    { status: 400 },
  );
}

export default function ResetPassword({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  if (actionData?.ok) {
    return (
      <AuthShell
        title="Password updated"
        footer={<>You can now <AuthLink to="/login">sign in</AuthLink> with your new password.</>}
      >
        <Alert tone="success">Your password has been reset.</Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password">
      <Form method="post" className="flex flex-col gap-4">
        {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
        <input type="hidden" name="token" value={loaderData.token} />
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
        />
        <Submit disabled={busy}>{busy ? "Saving..." : "Update password"}</Submit>
      </Form>
    </AuthShell>
  );
}
