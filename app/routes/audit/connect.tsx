import { Check, X } from "lucide-react";
import { Form, Link, redirect, useNavigation } from "react-router";

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
// LEGACY'S PROGRESS TICKER IS NOT PORTED. Its button fakes a four-step sequence
// ("Connecting to Stripe...", "Reading invoices...", "Analyzing decline
// codes...", "Building summary...") on an 1800ms interval while navigating away
// after 400ms, so every step after the first describes work that is not
// happening and the last three are shown to a visitor who is already on Stripe's
// consent screen. That is a fabricated progress indicator, ruling 39's class.
// The real pending state from useNavigation replaces it.
//
// ERRORS LAND HERE, NOT ON /audit. Legacy redirects every failure to
// `/audit?error=...` and its /audit page reads no error param at all, so a
// visitor whose state check failed is returned to the marketing page with no
// explanation and no idea the connection did not happen. Landing back on the
// consent screen with the reason keeps the retry one click away, and is the
// smallest correct version of a flow that currently fails silently.

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
    "Stripe granted more access than this audit asks for, so the run was refused. Nothing was read.",
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

function AccessLine({ item, allowed }: { item: string; allowed: boolean }) {
  const Icon = allowed ? Check : X;
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon
        className={`size-4 shrink-0 ${allowed ? "text-success-text" : "text-error-text"}`}
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="text-label text-text">{item}</span>
    </div>
  );
}

export default function AuditConnect({ loaderData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const message = loaderData.error
    ? (OAUTH_ERROR_MESSAGES[loaderData.error] ?? "Could not connect Stripe. Please try again.")
    : null;

  return (
    <div className="flex items-center justify-center px-4 py-[60px]">
      <div className="w-full max-w-[480px] rounded-[12px] border border-border bg-surface p-8 md:p-12">
        <h1 className="mb-2 text-center text-title font-semibold text-text">
          Connect your Stripe account
        </h1>
        <p className="mb-8 text-center text-label leading-relaxed text-text-subtle">
          We need read-only access to scan your failed payments from the last{" "}
          {loaderData.lookbackDays} days. We never store your data permanently.
        </p>

        {message ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-label text-error-text"
          >
            {message}
          </div>
        ) : null}

        <div className="mb-6 rounded-lg border border-border bg-bg p-4">
          <p className="mb-3 text-micro font-medium uppercase tracking-wide text-text-subtle">
            What we can do
          </p>
          {CAN_DO.map((item) => (
            <AccessLine key={item} item={item} allowed />
          ))}
          <p className="mb-3 mt-4 text-micro font-medium uppercase tracking-wide text-text-subtle">
            What we can never do
          </p>
          {CAN_NEVER_DO.map((item) => (
            <AccessLine key={item} item={item} allowed={false} />
          ))}
        </div>

        {loaderData.stripeEnabled ? (
          <Form method="post">
            <button
              type="submit"
              disabled={busy}
              className="block w-full rounded-md bg-purple p-[14px] text-center text-body font-semibold text-purple-bg transition-opacity duration-150 hover:opacity-80 disabled:opacity-60"
            >
              {busy ? "Redirecting to Stripe..." : "Connect Stripe and see my numbers"}
            </button>
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
            className="text-amber-text no-underline transition-opacity duration-500 hover:opacity-80"
          >
            See a demo first
          </Link>
        </p>
      </div>
    </div>
  );
}
