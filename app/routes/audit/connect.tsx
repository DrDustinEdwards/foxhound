import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, redirect, useFormAction, useNavigation } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// button, the alert and the focus ring read, as on /connect.
import "~/site-header.css";

import { AUDIT_LOOKBACK_DAYS, RATE_LIMIT_AUDIT } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { AUDIT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { buildAuditAuthorizeUrl } from "~/lib/stripe/connect";
import { setAuditStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect";

// Legacy's `/audit/connect` (blob `9d7075d8`, 2,139 bytes) plus its OAuth start
// (`/api/audit/connect`, blob `dedddf99`, 1,093 bytes), phase (f).
//
// TWO LEGACY FILES BECOME ONE ROUTE, because React Router already gives a page
// its own action. Legacy needs a client component and a separate GET API route
// only because a Next server component cannot post anywhere; the split is a
// framework artifact, not a decision, and merging it changes nothing a visitor
// can see.
//
// THE SCOPE IS THE WHOLE PHASE. Legacy requests `read_write` here for an audit
// that never writes, on a page that tells the visitor "We need read-only access"
// and lists "Create new charges or move money" under what it can never do.
// Under 362 ruling 1 Foxhound requests `read_only`, which makes all three of
// legacy's "can never" lines true for the first time and makes the published
// sentence "The audit only reads." provable rather than aspirational. Every line
// of legacy's consent copy is ported verbatim; only the request changed.
//
// LEGACY'S PROGRESS TICKER KEEPS ONLY ITS TRUE STEP (J42). Its button fakes a
// four-step sequence ("Connecting to Stripe...", "Reading invoices...",
// "Analyzing decline codes...", "Building summary...") on an 1800ms interval
// while navigating away after 400ms, so every step after the first describes
// work that is not happening and is shown to a visitor already on Stripe's
// consent screen. Fixing copy where Recova lied needs no approval (RULES.md
// 1.2), so the three untrue steps go and the first, which is true, stays,
// announced through a polite status region as Recova's role="status" did.
//
// ERRORS LAND HERE, NOT ON /audit. Legacy redirects every failure to
// `/audit?error=...` and its /audit page reads no error param at all, so a
// visitor whose state check failed is returned to the marketing page with no
// explanation and no idea the connection did not happen. Landing back on the
// consent screen with the reason keeps the retry one click away, and is the
// smallest correct version of a flow that currently fails silently. This is a
// visible difference with no line in parity/APPROVED-DIFFERENCES.md yet; J42
// left it standing and put it to Dustin rather than choosing a direction.

export function meta() {
  return [
    { title: "Connect your Stripe account - Foxhound" },
    // Not indexable: this is a step inside a flow, and legacy's own sitemap
    // omits it too. robots.txt carries the same exclusion.
    { name: "robots", content: "noindex" },
  ];
}

const CAN_DO = [
  "View failed invoices and payment history",
  "Scan decline codes and categories",
  "Calculate your recoverable revenue",
];

const CAN_NEVER_DO = [
  "Create new charges or move money",
  "Access your payouts or bank account",
  "Store your Stripe data permanently",
];

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many audit attempts from this network. Please try again later.",
  cancelled: "Stripe connection was cancelled. Nothing was read.",
  invalid_state: "That audit link expired. Please start again.",
  scope_refused:
    "Stripe did not grant read-only access, so the run was refused. Nothing was read.",
  failed: "Could not complete the Stripe connection. Please try again.",
  session_expired: "That audit session expired. Connect again to see current numbers.",
};

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  return {
    lookbackDays: AUDIT_LOOKBACK_DAYS,
    stripeEnabled: Boolean(env.STRIPE_CLIENT_ID),
    error: new URL(request.url).searchParams.get("error"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);

  // 311's limiter, USED UNCHANGED, at legacy's own numbers (its RATE_LIMIT_AUDIT
  // is 10 per hour on `audit-connect:{ip}`). Fail-open like every other caller,
  // which is legacy's posture too: its Redis limiter returns true on any error
  // for the same reason.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed = await isWithinRateLimit(
    env,
    "audit-connect",
    ip,
    RATE_LIMIT_AUDIT.max,
    RATE_LIMIT_AUDIT.windowMs,
  );
  if (!allowed) return redirect("/audit/connect?error=rate_limited");

  if (!env.STRIPE_CLIENT_ID) {
    return redirect("/audit/connect?error=failed");
  }

  // THE EXISTING STATE SHAPE WITH A NEW ACTION, not a parallel implementation.
  // The cookie is the audit's own (`audit_oauth_state`, legacy's name), so a
  // merchant with a half-finished /connect in another tab keeps it.
  const state = buildConnectState(AUDIT_ACTION);
  return redirect(buildAuditAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setAuditStateCookie(state) },
  });
}

/** Recova's two labelled lists inside the inner box. Each is a real list
 *  named by its heading. Recova's labels are `text-xs font-medium` with no
 *  letter spacing, so none is added. Capsomer has no can and cannot list, so
 *  this is composed from Foxhound's tokens, as on /connect (a Capsomer gap,
 *  named in the PR). */
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
      <p id={id} className={`mb-3 text-micro font-medium uppercase text-text-subtle ${allowed ? "" : "mt-4"}`}>
        {heading}
      </p>
      <ul aria-labelledby={id} className="m-0 list-none p-0">
        {items.map((item) => (
          <li key={item} className="mb-2 flex items-center gap-2 text-label text-text">
            <Icon
              className={`size-4 shrink-0 ${allowed ? "text-success-text" : "text-error-text"}`}
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

/**
 * Recova's frame: `flex items-center justify-center px-4 py-[60px]` around one
 * `w-full max-w-[480px]` card with `p-12`. The card is Capsomer's panel
 * through its HTML contract, body only, because the React Panel always draws
 * an h2 header band and this page's one heading is its h1 (the gap J62
 * named). The wrapper puts the parts in Capsomer's teal family with
 * Foxhound's neutrals (.fh-cap), so the button and its focus ring are teal
 * (Q11). The inner div adds 36px by 32px to the panel body's 12px by 16px,
 * which is Recova's 48px on every side at every width, as the sign-in card
 * does (RULES.md 5.1).
 */
function AuditConnectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center px-4 py-[60px]">
      <div
        className="fh-cap w-full max-w-[480px] [--border-focus:var(--ring)]"
        data-family="teal"
        data-audit-connect=""
      >
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="px-8 py-9">{children}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Recova's only true progress step, shown while the browser leaves for Stripe. */
const PENDING_LABEL = "Connecting to Stripe...";

export default function AuditConnect({ loaderData }: Route.ComponentProps) {
  // Pending only while THIS form's POST is in flight. Any navigation sets the
  // router's state, so following "See a demo first" or a header link would
  // otherwise announce "Connecting to Stripe..." while going somewhere else
  // (review round 1, must-fix 1).
  const navigation = useNavigation();
  const formAction = useFormAction();
  const busy =
    navigation.state !== "idle" &&
    navigation.formMethod?.toUpperCase() === "POST" &&
    navigation.formAction === formAction;
  const message = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? "Could not connect Stripe. Please try again.")
    : null;

  return (
    <AuditConnectFrame>
      <h1 className="mb-2 text-center text-title font-semibold text-text">Connect your Stripe account</h1>
      <p className="mb-8 text-center text-label leading-relaxed text-text-subtle">
        We need read-only access to scan your failed payments from the last {loaderData.lookbackDays}{" "}
        days. We never store your data permanently.
      </p>

      {message ? (
        <div className="mb-6">
          <Alert tone="crit">{message}</Alert>
        </div>
      ) : null}

      <div className="mb-6 rounded-lg border border-border bg-bg p-4">
        <AccessList id="audit-connect-can" heading="What we can do" items={CAN_DO} allowed />
        <AccessList
          id="audit-connect-cannot"
          heading="What we can never do"
          items={CAN_NEVER_DO}
          allowed={false}
        />
      </div>

      {loaderData.stripeEnabled ? (
        <Form method="post" className="grid">
          <Button type="submit" variant="primary" size="lg" pending={busy}>
            {/* The label stays the same while pending: Capsomer 0.9.0 does not
                paint it then (only the spinner shows), and the status region
                below says "Connecting to Stripe...", so the name does not
                change under a screen reader as well (review round 1).
                The one Foxhound class inside a Capsomer part, and it is on this
                page's own label, not the button: Capsomer's button never wraps,
                so Recova's 33-character label is clipped below about 400px,
                where Recova's own button wraps to two lines. Named in the PR
                for the per-site layer (capsomer job_ec5ec0754626). */}
            <span className="whitespace-normal">
              Connect Stripe and see my numbers<span aria-hidden="true"> →</span>
            </span>
          </Button>
          <span role="status" aria-live="polite" className="sr-only">
            {busy ? PENDING_LABEL : ""}
          </span>
        </Form>
      ) : (
        <p className="text-center text-label text-text-tertiary">
          Stripe Connect is not configured in this environment yet.
        </p>
      )}

      <p className="mt-4 text-center text-micro text-text-subtle">
        {"Read-only · Secure · Free · "}
        <Link
          to="/demos/recovery"
          className="inline-flex min-h-6 items-center text-brand-text underline underline-offset-2 hover:opacity-80"
        >
          See a demo first
        </Link>
      </p>
    </AuditConnectFrame>
  );
}
