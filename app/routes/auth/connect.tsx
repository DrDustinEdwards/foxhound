import { data, Form, redirect, useNavigation } from "react-router";

import { AuthShell, Field, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getDb } from "~/db";
import { createAccountForUser, getSession, resolveMembership } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/connect";

export function meta() {
  return [{ title: "Set up your account - Foxhound" }];
}

// Account setup + resolution shell. This is where an authenticated-but-no-account
// user lands (the middleware redirect target, C5) to create their account. The
// Stripe Connect OAuth token exchange is Phase 4; here we build the account and
// leave a clearly marked seam for the connect step.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const membership = await resolveMembership(getDb(env), session.user.id);
  return {
    hasAccount: Boolean(membership),
    accountName: membership?.accountName ?? null,
    userName: session.user.name,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  // Idempotency guard: never mint a second account for a user who already has one.
  const existing = await resolveMembership(db, session.user.id);
  if (existing) return redirect("/dashboard");

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) {
    return data({ error: "Enter a name for your account." }, { status: 400 });
  }

  await createAccountForUser(db, session.user.id, name);
  // Phase 4 inserts the Stripe Connect step here; for now, straight to the app.
  return redirect("/dashboard");
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  if (loaderData.hasAccount) {
    return (
      <AuthShell
        title="Connect Stripe"
        subtitle={`${loaderData.accountName ?? "Your account"} is set up.`}
        footer={<AuthLink to="/dashboard">Go to dashboard</AuthLink>}
      >
        <Alert tone="success">
          Stripe Connect is wired up in the next phase. Your account is ready.
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Name your account"
      subtitle="One more step before you connect Stripe."
    >
      <Form method="post" className="flex flex-col gap-4">
        {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
        <Field
          label="Account name"
          name="name"
          autoComplete="organization"
          defaultValue={loaderData.userName ?? undefined}
        />
        <Submit disabled={busy}>{busy ? "Creating..." : "Create account"}</Submit>
      </Form>
    </AuthShell>
  );
}
