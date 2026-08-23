import { and, eq, isNull } from "drizzle-orm";
import { Check, X } from "lucide-react";
import { data, Form, redirect, useNavigation } from "react-router";

import { AuthShell, Field, Submit, Alert, AuthLink } from "~/components/auth-ui";
import { getDb, stripeConnections } from "~/db";
import {
  createAccountForUser,
  getSession,
  resolveActiveMembership,
  resolveMembership,
} from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { buildConnectState, CONNECT_ACTION } from "~/lib/stripe/connect-state";
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
  // THE ACTIVE ACCOUNT, not the earliest. This loader renders an account NAME
  // and that account's connection state on the screen where a merchant grants a
  // live payment processor, and the OAuth flow the action starts attaches to
  // whichever account the CALLBACK resolves, which is the active one
  // (connect-callback.ts:223, phase (d)). While this read used the null-marker
  // shim the two disagreed: a merchant switched to a second account, then
  // bounced back here by any `/connect?error=...` redirect, was shown the first
  // account's name and the first account's "already connected" state for a flow
  // that would attach somewhere else. Session 61, phase (c).
  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );

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
  // THE SHIM IS CORRECT HERE, and it is the last caller left. This action reads
  // only `!membership`, which is "does this user hold ANY account", and that
  // answer is identical under every resolution: the marked membership and the
  // earliest membership are both non-null exactly when the user holds one. No
  // account IDENTITY is consumed below, so nothing can resolve to the wrong
  // account. Kept rather than substituted so the shim keeps a live caller and a
  // test, instead of becoming dead code the next session deletes on sight.
  const membership = await resolveMembership(db, session.user.id);

  // No account yet: create it. The membership read above is a fast path, not a
  // lock, and it never was: a concurrent double-submit can pass it twice. What
  // stops the second submit is inside createAccountForUser, which serializes
  // both through one money-write Durable Object partitioned by the user and
  // gives them the SAME idempotency key, so the loser is a no-op that reports
  // the winner's account (ruling 329 phase (d), the debt 327 named). Either way
  // the account now exists, so both outcomes redirect to /connect, where the
  // loader re-reads the membership and shows the Connect Stripe step.
  if (!membership) {
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      return data({ error: "Enter a name for your account." }, { status: 400 });
    }
    await createAccountForUser(env, db, session.user.id, name);
    return redirect("/connect");
  }

  // Account exists: start the Stripe Connect OAuth flow with a CSRF state cookie.
  if (!env.STRIPE_CLIENT_ID) {
    return data(
      { error: "Stripe Connect is not configured in this environment yet." },
      { status: 400 },
    );
  }
  // MARKED "connect" as of ruling 329 phase (d). It used to be a bare
  // crypto.randomUUID(), which the callback could only read as "not
  // add_account". An unmarked state is how legacy's own add-account control
  // falls through to the upsert branch (DEFECT 1), so both flows now say what
  // they are and the callback refuses anything that says neither.
  const state = buildConnectState(CONNECT_ACTION);
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setStateCookie(state) },
  });
}

// The access disclosure panel, restored from legacy app/connect/page.tsx
// (ruling 20d). Legacy told a merchant what the connection could and could not
// do, in plain terms, on the screen where they grant it; the rebuild shipped the
// button without it.
//
// NOT a verbatim port, because legacy's list is wrong for Foxhound in three
// places (ruling 39: do not restore legacy defects). Every line below was
// checked against the code that actually calls Stripe:
//
//   - Legacy claimed "Register a webhook to receive payment events". Foxhound
//     never calls webhookEndpoints.create on a connected account; Connect events
//     arrive at one platform-level endpoint. Dropped rather than ported.
//   - Foxhound sets a default payment method (card-update/service.ts calls
//     customers.update and subscriptions.update) and submits dispute evidence
//     (disputes/submission.ts calls disputes.update with submit:true). Legacy
//     disclosed neither. Both are writes a merchant should be told about.
//   - "Create new charges or move money" needs the qualifier legacy left off:
//     retrying an invoice DOES move money. What is true is that nothing here
//     creates a charge outside an invoice the merchant already issued.
const CONNECTION_CAN = [
  "Read your invoices, subscriptions, disputes, and customer records",
  "Retry payment on an invoice that has already failed",
  "Set a customer default payment method after that customer updates their card",
  "Submit dispute evidence, only after someone on your team approves it",
];

const CONNECTION_CANNOT = [
  "Create a charge outside an invoice you already issued",
  "Reach your payouts or your bank account",
  "Store raw card numbers",
  "Change your prices, products, or subscription plans",
];

function AccessDisclosure() {
  return (
    <div className="mb-6 rounded-lg border border-border bg-bg p-4">
      <p className="mb-3 font-mono text-micro uppercase tracking-wide text-text-tertiary">
        What Foxhound can do
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {CONNECTION_CAN.map((item) => (
          <li key={item} className="flex items-start gap-2 text-label text-text-secondary">
            <Check className="mt-0.5 size-4 shrink-0 text-success-text" strokeWidth={1.5} aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <p className="mb-3 mt-4 font-mono text-micro uppercase tracking-wide text-text-tertiary">
        What Foxhound can never do
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {CONNECTION_CANNOT.map((item) => (
          <li key={item} className="flex items-start gap-2 text-label text-text-secondary">
            <X className="mt-0.5 size-4 shrink-0 text-error-text" strokeWidth={1.5} aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-label text-text-tertiary">
        You can disconnect at any time from Settings, which stops every active sequence.
      </p>
    </div>
  );
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
      subtitle="Foxhound needs read and write access to your Stripe account so it can retry invoices that have failed. Here is exactly what that covers."
      footer={<AuthLink to="/dashboard">Skip for now</AuthLink>}
    >
      {oauthError ? <Alert tone="error">{oauthError}</Alert> : null}
      {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
      <AccessDisclosure />
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
