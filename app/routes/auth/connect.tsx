import { and, eq, isNull } from "drizzle-orm";
import { data, Form, redirect, useNavigation } from "react-router";

import { AuthShell, Field, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getDb, stripeConnections } from "~/db";
import { createAccountForUser, getSession, resolveMembership } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { setStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect";

export function meta() {
  return [{ title: "Set up your account - Foxhound" }];
}

// Account setup + Stripe Connect. Phase 3 built the account-naming step; Phase 4a
// adds the real Stripe Connect OAuth start (the token exchange lives in the
// /connect/callback resource route). An authenticated-but-no-account user lands
// here (middleware redirect target); once the account exists, this offers the
// Connect Stripe step.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  const membership = await resolveMembership(db, session.user.id);

  let hasConnection = false;
  if (membership) {
    const rows = await db
      .select({ id: stripeConnections.id })
      .from(stripeConnections)
      .where(
        and(
          eq(stripeConnections.accountId, membership.accountId),
          isNull(stripeConnections.disconnectedAt),
        ),
      )
      .limit(1);
    hasConnection = rows.length > 0;
  }

  return {
    hasAccount: Boolean(membership),
    accountName: membership?.accountName ?? null,
    userName: session.user.name,
    hasConnection,
    stripeEnabled: Boolean(env.STRIPE_CLIENT_ID),
    error: new URL(request.url).searchParams.get("error"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  const membership = await resolveMembership(db, session.user.id);

  // No account yet: create it. The membership read above is a fast path, not a
  // lock: a concurrent double-submit can lose the single-account race, in which
  // case createAccountForUser returns already_member instead of throwing. Either
  // way the account now exists, so both outcomes redirect to /connect, where the
  // loader re-reads the membership and shows the Connect Stripe step.
  if (!membership) {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      return data({ error: "Enter a name for your account." }, { status: 400 });
    }
    await createAccountForUser(db, session.user.id, name);
    return redirect("/connect");
  }

  // Account exists: start the Stripe Connect OAuth flow with a CSRF state cookie.
  if (!env.STRIPE_CLIENT_ID) {
    return data(
      { error: "Stripe Connect is not configured in this environment yet." },
      { status: 400 },
    );
  }
  const state = crypto.randomUUID();
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setStateCookie(state) },
  });
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Stripe connection was cancelled.",
  no_code: "Stripe did not return an authorization code. Please try again.",
  invalid_state: "The connection request expired. Please try again.",
  token_exchange_failed: "Could not complete the Stripe connection. Please try again.",
};

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const oauthError = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? "Could not connect Stripe. Please try again.")
    : null;

  // No account yet: name it.
  if (!loaderData.hasAccount) {
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

  // Account exists and Stripe is connected.
  if (loaderData.hasConnection) {
    return (
      <AuthShell
        title="Stripe connected"
        subtitle={`${loaderData.accountName ?? "Your account"} is ready.`}
        footer={<AuthLink to="/dashboard">Go to dashboard</AuthLink>}
      >
        <Alert tone="success">
          Your Stripe account is connected. Foxhound can now recover failed
          payments for you.
        </Alert>
      </AuthShell>
    );
  }

  // Account exists, Stripe not yet connected: offer the Connect step.
  return (
    <AuthShell
      title="Connect Stripe"
      subtitle="Foxhound connects to your Stripe account with read/write access to recover failed payments."
      footer={<AuthLink to="/dashboard">Skip for now</AuthLink>}
    >
      {oauthError ? <Alert tone="error">{oauthError}</Alert> : null}
      {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
      {loaderData.stripeEnabled ? (
        <Form method="post">
          <Submit disabled={busy}>{busy ? "Redirecting..." : "Connect Stripe"}</Submit>
        </Form>
      ) : (
        <p className="text-label text-text-tertiary">
          Stripe Connect is not configured in this environment yet.
        </p>
      )}
    </AuthShell>
  );
}
