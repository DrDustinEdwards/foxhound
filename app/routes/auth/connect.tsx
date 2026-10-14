import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { and, eq, isNull } from "drizzle-orm";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// button, the field, the banner and alert, and the focus ring read. The site
// header loads the same file; importing it here keeps the page whole under any
// layout.
import "~/site-header.css";

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

// The access-disclosure panel (ruling 20(d)): Recova's own panel from
// app/connect/page.tsx (blob a79ee373, lines 21 to 31 and 59 to 77), restored
// on the screen where a merchant grants the connection (J53, row A6).
//
// RECOVA'S LINES ARE KEPT WORD FOR WORD WHERE THEY ARE TRUE OF FOXHOUND. Three
// are not, and are fixed as copy, never by narrowing the scope (RULES.md 2.2):
//
//   - "Register a webhook to receive payment events" is dropped. Foxhound never
//     calls webhookEndpoints.create on a connected account; Connect events reach
//     one platform-level endpoint.
//   - "Create new charges or move money" is false: retrying an invoice moves
//     money. What is true is that nothing here creates a charge outside an
//     invoice the merchant already issued.
//   - Recova's "can do" list names one write, retrying an invoice. Foxhound's
//     read_write grant is used for two more, so leaving them off would make the
//     list say less than the grant does: setting a customer's default payment
//     method (card-update/service.ts, customers.update and
//     subscriptions.update) and submitting dispute evidence a person approved
//     (disputes/submission.ts, disputes.update with submit:true).
//
// Nothing else is added: Foxhound's earlier wording and its extra lines went
// back to Recova's in J53, and are listed in the PR as questions for Dustin.
const CONNECTION_CAN = [
  "View failed invoices and payment history",
  "Retry failed invoice payments",
  "Set a customer default payment method after that customer updates their card",
  "Submit dispute evidence, only after someone on your team approves it",
];

const CONNECTION_CANNOT = [
  "Create a charge outside an invoice you already issued",
  "Access your payouts or bank account",
  "Store raw card data",
];

function AccessList({
  id,
  heading,
  items,
  allowed,
}: {
  id: string;
  heading: string;
  items: string[];
  allowed: boolean;
}) {
  const Icon = allowed ? Check : X;
  return (
    <>
      <p
        id={id}
        className={`mb-3 text-micro font-medium uppercase tracking-wide text-text-subtle ${allowed ? "" : "mt-4"}`}
      >
        {heading}
      </p>
      <ul aria-labelledby={id} className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-label text-text">
            <Icon
              className={`mt-0.5 size-4 shrink-0 ${allowed ? "text-success-text" : "text-error-text"}`}
              strokeWidth={1.5}
              aria-hidden
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Recova's inner box: the two lists on the page ground, inside the card.
 *  Capsomer has no can and cannot list, so this is composed from Foxhound's
 *  own tokens and named in the PR as a Capsomer gap. */
function AccessDisclosure() {
  return (
    <div className="mb-6 rounded-lg border border-border bg-bg p-4">
      <AccessList id="connect-can" heading="What Foxhound can do" items={CONNECTION_CAN} allowed />
      <AccessList
        id="connect-cannot"
        heading="What Foxhound can never do"
        items={CONNECTION_CANNOT}
        allowed={false}
      />
    </div>
  );
}

// Recova's error words (app/connect/page.tsx lines 11 to 19) for every code
// Foxhound's callback sends here. Recova's three setup codes (oauth_failed,
// billing_setup_failed, account_products_setup_failed) are not carried:
// nothing in Foxhound sends them. stripe_account_already_connected is
// Foxhound's own refusal (one live Foxhound account per Stripe account, RULES.md
// 4.6); Recova moved the connection instead, so it has no words for it. "Please
// try again" would be untrue there, since trying again is refused again, and the
// sentence names no account, so it tells nobody whose ledger holds it.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "You cancelled the Stripe connection. Try again when ready.",
  invalid_state: "Security check failed. Please try again.",
  no_code: "Stripe did not return an authorization code. Please try again.",
  token_exchange_failed: "Stripe could not complete the connection. Please try again.",
  stripe_account_already_connected: "This Stripe account is already connected to a Foxhound account.",
};
const OAUTH_ERROR_FALLBACK = "Something went wrong. Please try again.";

/** A small text link on the card, teal, underlined so it is not told apart by
 *  colour alone, and 24px tall as a target. */
function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-6 items-center text-brand-text underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </Link>
  );
}

/**
 * The page's frame: Recova's one card, centred, 480px wide (app/connect/page.tsx
 * line 43), under the site header (J10). Not AuthShell: Recova's /connect has no
 * brand panel, and AuthShell's own main landmark would sit inside the marketing
 * layout's.
 *
 * The card is Capsomer's panel through its HTML contract, body only, because
 * the React Panel always draws an h2 header band and this page's one heading is
 * its h1 (the Capsomer gap J62 named). The wrapper puts the parts in Capsomer's
 * teal family with Foxhound's neutrals (.fh-cap, the pairing the site header
 * uses), so the button and its focus ring are teal (Q11). One inner div holds
 * Recova's spacing, so the panel body's own grid gap does not replace it.
 */
function ConnectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center px-4 py-[60px]">
      <div
        className="fh-cap w-full max-w-[480px] [--border-focus:var(--ring)]"
        data-family="teal"
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

function ConnectHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <h1 className="mb-2 text-center text-title font-semibold text-text">{title}</h1>
      <p className="mb-8 text-center text-label leading-relaxed text-text-subtle">{subtitle}</p>
    </>
  );
}

export default function Connect({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const oauthError = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? OAUTH_ERROR_FALLBACK)
    : null;

  // No account yet: name it. Foxhound's own step (its account exists before
  // the connection does); Recova made the account inside its callback.
  if (!loaderData.hasAccount) {
    return (
      <ConnectFrame>
        <ConnectHeading title="Name your account" subtitle="One more step before you connect Stripe." />
        <Form method="post" className="grid gap-4">
          {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
          {/* Capsomer's field through its HTML contract. The React Field
              sets the input's required from its own prop, so keeping the
              browser's required check would also print a "Required" marker
              (12px, off the five sizes) this step never had. */}
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="connect-account-name">
              Account name
            </label>
            <input
              id="connect-account-name"
              className="cap-input"
              name="name"
              type="text"
              autoComplete="organization"
              required
              defaultValue={loaderData.userName ?? undefined}
            />
          </div>
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
        <ConnectHeading
          title="Stripe connected"
          subtitle={`${loaderData.accountName ?? "Your account"} is ready.`}
        />
        <Banner tone="ok">
          Your Stripe account is connected. Foxhound can now recover failed payments for you.
        </Banner>
        <p className="mt-4 text-center text-label">
          <CardLink to="/dashboard">Go to dashboard</CardLink>
        </p>
      </ConnectFrame>
    );
  }

  // Account exists, Stripe not yet connected: Recova's page.
  return (
    <ConnectFrame>
      <ConnectHeading
        title="Connect your Stripe account"
        subtitle="Foxhound needs read/write access to retry failed invoices on your behalf. You can disconnect at any time."
      />
      {oauthError || actionData?.error ? (
        <div className="mb-6">
          <Alert tone="crit">{oauthError ?? actionData?.error}</Alert>
        </div>
      ) : null}
      <AccessDisclosure />
      {loaderData.stripeEnabled ? (
        <Form method="post" className="grid">
          <Button type="submit" variant="primary" pending={busy}>
            {busy ? "Redirecting..." : "Connect Stripe"}
          </Button>
        </Form>
      ) : (
        <p className="text-center text-label text-text-tertiary">
          Stripe Connect is not configured in this environment yet.
        </p>
      )}
      <p className="mt-4 text-center text-micro text-text-subtle">
        Not ready? <CardLink to="/demos/recovery">See a demo first</CardLink>
      </p>
      <p className="mt-2 text-center text-micro text-text-subtle">
        <CardLink to="/settings">Manage account</CardLink>
      </p>
    </ConnectFrame>
  );
}
