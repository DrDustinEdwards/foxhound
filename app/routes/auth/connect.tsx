import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { TextField } from "capsomer/react/field";
import { PermissionList } from "capsomer/react/consent";
import type { ReactNode } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { AuthLink } from "~/components/auth-link";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/consent.css";
import "capsomer/field.css";
import "capsomer/panel.css";
// Capsomer's tokens and the amber family (capbase layer), which the panel, the button, the field, the banner and alert, and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { getDb, stripeConnections } from "~/db";
import {
  createAccountForUser,
  getSession,
  MEMBER_ROLE,
  resolveActiveMembership,
  resolveMembership,
} from "~/lib/auth";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { buildConnectState, CONNECT_ACTION } from "~/lib/stripe/connect-state";
import { activeConnectionWhere } from "~/lib/stripe/connections.server";
import { setOAuthStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";
import "~/auth.css";

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

export function meta() {
  return [{ title: "Set up your account - Foxhound" }];
}

// Account setup + Stripe Connect. An authenticated-but-no-account user lands here (middleware redirect target); once the account exists, this offers the Connect Stripe step (the token exchange lives in the /connect/callback resource route).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  // THE ACTIVE ACCOUNT, not the earliest. This loader renders an account NAME and that account's connection state on the screen where a merchant grants a live payment processor, and the OAuth flow the action starts attaches to whichever account the CALLBACK resolves, which is the active one. Reading the earliest would show a merchant switched to a second account the first account's name and "already connected" state for a flow that attaches somewhere else.
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
      .where(activeConnectionWhere(membership.accountId))
      .limit(1);
    hasConnection = rows.length > 0;
  }

  return {
    hasAccount: Boolean(membership),
    accountName: membership?.accountName ?? null,
    userName: session.user.name,
    hasConnection,
    // Only an owner may attach a Stripe account; a member is told so instead of being offered a button the action and the callback would refuse.
    isOwner: membership?.role === MEMBER_ROLE.OWNER,
    stripeEnabled: Boolean(env.STRIPE_CLIENT_ID),
    error: new URL(request.url).searchParams.get("error"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);
  // THE SHIM IS CORRECT HERE, and it is the last caller left. This action reads only `!membership`, "does this user hold ANY account", which is identical under every resolution. No account IDENTITY is consumed below, so nothing can resolve to the wrong account.
  const membership = await resolveMembership(db, session.user.id);

  // No account yet: create it. The membership read above is a fast path, not a lock: a concurrent double-submit can pass it twice. What stops the second submit is inside createAccountForUser, which serializes both through one money-write Durable Object partitioned by the user and gives them the SAME idempotency key, so the loser is a no-op that reports the winner's account. Either way the account now exists, so both outcomes redirect to /connect, where the loader re-reads the membership and shows the Connect Stripe step.
  if (!membership) {
    const form = await readForm(request, BODY_MAX_BYTES);
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
  // ONLY AN OWNER STARTS THE FLOW, on the account the callback will attach to (the active one). The callback asks again before it exchanges the code, so this is the early, clear refusal rather than the only one.
  const active = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (active?.role !== MEMBER_ROLE.OWNER) {
    return data({ error: OWNER_REQUIRED_MESSAGE }, { status: 403 });
  }
  // MARKED "connect": an unmarked state is how an add-account control falls through to the upsert branch, so both flows say what they are and the callback refuses anything that says neither.
  const state = buildConnectState(CONNECT_ACTION, session.user.id);
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setOAuthStateCookie(state) },
  });
}

// The access-disclosure panel, on the screen where a merchant grants the connection. The lines are fixed as copy, never by narrowing the scope:
// - The read line is the wider one: Foxhound reads every customer, subscription, invoice and charge (intelligence/sync.server.ts), disputes and payment methods.
// - No "Register a webhook to receive payment events": Foxhound never calls webhookEndpoints.create on a connected account; Connect events reach one platform-level endpoint.
// - The "can do" list names every write the grant is used for: retrying an invoice, setting a customer's default payment method (card-update/service.ts), opening a subscription-mode Stripe checkout for a win-back customer who chooses to resubscribe (createResubscribeSession), submitting dispute evidence a person approved (disputes/submission.ts), closing a dispute the merchant chose to accept (disputes/accept.server.ts), and refunding a charge the merchant chose to refund after an early fraud warning (disputes/fraud-warnings.server.ts).
// - "Create new charges or move money" is false: a retried invoice moves money, and a completed win-back checkout makes a new subscription, invoice and charge. Foxhound charges a customer only those two ways.
const CONNECTION_CAN = [
  "Read your invoices, subscriptions, disputes, and customer records",
  "Retry failed invoice payments",
  "Set a customer default payment method after that customer updates their card",
  "Open a Stripe checkout when a former customer chooses to resubscribe",
  "Submit dispute evidence, only after someone on your team approves it",
  "Close a dispute at Stripe, only when you choose to accept it",
  "Refund a charge, only when you choose to refund it after an early fraud warning",
];

const CONNECTION_CANNOT = [
  "Charge a customer except by retrying a failed invoice or through a checkout they complete",
  "Access your payouts or bank account",
  "Store raw card data",
];

/** The inner box: the two lists on the page ground, inside the card, as Capsomer's permission lists. */
function AccessDisclosure() {
  return (
    <div className="fh-connect-note">
      <PermissionList
        id="connect-can"
        heading="What Foxhound can do"
        items={CONNECTION_CAN}
        allowed
      />
      <PermissionList
        id="connect-cannot"
        heading="What Foxhound can never do"
        items={CONNECTION_CANNOT}
        allowed={false}
      />
    </div>
  );
}

// Foxhound's own refusal: only an account owner attaches a Stripe account.
// Shown by the action, the callback's bounce and the page itself.
const OWNER_REQUIRED_MESSAGE =
  "Only an account owner can connect Stripe. Ask the owner to connect it.";

// Error words for every code Foxhound's callback sends here. stripe_account_already_connected is Foxhound's own refusal (one live Foxhound account per Stripe account); "Please try again" would be untrue there, since trying again is refused again, and the sentence names no account, so it tells nobody whose ledger holds it.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "You canceled the Stripe connection. Try again when ready.",
  invalid_state: "Security check failed. Please try again.",
  no_code: "Stripe did not return an authorization code. Please try again.",
  token_exchange_failed: "Stripe could not complete the connection. Please try again.",
  stripe_account_already_connected:
    "This Stripe account is already connected to a Foxhound account.",
  owner_required: OWNER_REQUIRED_MESSAGE,
  scope_refused: "Stripe did not grant the read and write access Foxhound needs. Please try again.",
};
const OAUTH_ERROR_FALLBACK = "Something went wrong. Please try again.";

/** The page's frame: one card, centered, 480px wide, under the site header. Not AuthShell: there is no brand panel, and AuthShell's own main landmark would sit inside the marketing layout's. The card is Capsomer's panel through its HTML contract, body only, because the React Panel always draws an h2 header band and this page's one heading is its h1. The wrapper puts the parts in Capsomer's amber family with Foxhound's neutrals (.fh-cap), so the button and its focus ring are amber. One inner div holds the spacing, so the panel body's own grid gap does not replace it. */
function ConnectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="fh-connect-page">
      <div
        className="fh-connect-card fh-cap"
        data-cap-site="foxhound"
        data-family="amber"
        data-connect=""
      >
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div>{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ConnectHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1
        className={`${subtitle ? "fh-auth-title-sub" : "fh-auth-title"} fh-title fh-semibold fh-text`}
      >
        {title}
      </h1>
      {subtitle ? <p className="fh-auth-lede fh-small fh-quiet">{subtitle}</p> : null}
    </>
  );
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const oauthError = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? OAUTH_ERROR_FALLBACK)
    : null;

  // No account yet: name it. The account exists before the connection does.
  if (!loaderData.hasAccount) {
    return (
      <ConnectFrame>
        <ConnectHeading title="Name your account" />
        <Form method="post" className="fh-connect-form">
          {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
          {/* The browser's required check, with no "Required" marker: this
              step has one field and never had one. */}
          <TextField
            id="connect-account-name"
            label="Account name"
            name="name"
            autoComplete="organization"
            required
            showRequired={false}
            defaultValue={loaderData.userName ?? undefined}
          />
          <Button type="submit" variant="primary" pending={busy}>
            {busy ? "Creating..." : "Create account"}
          </Button>
        </Form>
      </ConnectFrame>
    );
  }

  // Account exists and Stripe is connected.
  if (loaderData.hasConnection) {
    return (
      <ConnectFrame>
        <ConnectHeading title="Stripe connected" subtitle={loaderData.accountName ?? undefined} />
        <p className="fh-auth-after fh-small">
          <AuthLink to="/console">Go to dashboard</AuthLink>
        </p>
      </ConnectFrame>
    );
  }

  // Account exists, Stripe not yet connected.
  return (
    <ConnectFrame>
      <ConnectHeading
        title="Connect your Stripe account"
        subtitle="Foxhound needs read/write access to retry failed invoices on your behalf. You can disconnect at any time."
      />
      {oauthError || actionData?.error ? (
        <div className="fh-mb-6">
          <Alert tone="crit">{oauthError ?? actionData?.error}</Alert>
        </div>
      ) : null}
      <AccessDisclosure />
      {!loaderData.isOwner ? (
        <p className="fh-center fh-small fh-quiet">{OWNER_REQUIRED_MESSAGE}</p>
      ) : loaderData.stripeEnabled ? (
        <Form method="post">
          <Button type="submit" variant="primary" pending={busy} block>
            {busy ? "Redirecting..." : "Connect Stripe"}
          </Button>
        </Form>
      ) : (
        <p className="fh-center fh-small fh-quiet">
          Stripe Connect is not configured in this environment yet.
        </p>
      )}
      <p className="fh-auth-after fh-tiny fh-quiet">
        Not ready? <AuthLink to="/demos/recovery">See a demo first</AuthLink>
      </p>
      <p className="fh-connect-fine fh-tiny fh-quiet">
        <AuthLink to="/settings">Manage account</AuthLink>
      </p>
    </ConnectFrame>
  );
}
